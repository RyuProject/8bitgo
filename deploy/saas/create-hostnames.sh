#!/bin/sh
# 在 SaaS 区域 8bitgo.top 上建（或复用）8bitgo.com 的全部 custom hostname，并在 Cloudflare 上的
# 8bitgo.com 区域补所有权 TXT 与 DCV 记录；同时把最低 TLS 设为 1.2。可重复运行，见 README.md。
#
# 用法：CLOUDFLARE_API_TOKEN=<令牌> ./create-hostnames.sh [主机名…]
# 令牌需要：两个区域的 Zone Read、DNS Edit、SSL and Certificates Edit。
set -eu
: "${CLOUDFLARE_API_TOKEN:?需要 CLOUDFLARE_API_TOKEN}"
ZONE_COM=8b681704ebdc7249aec1b9d18669a78f   # 8bitgo.com（NS 迁走前）
ZONE_TOP=513afef951fc4989dfcff6f741d96fc9   # 8bitgo.top（SaaS 区域）
DCV_UUID=7336034047451951
# 这三个名字的 _acme-challenge 正在给 8bitgo.com 区域自己的证书做 TXT 验证，不能放 CNAME。
TXT_ONLY=" 8bitgo.com image.8bitgo.com roms.8bitgo.com "
[ $# -gt 0 ] || set -- 8bitgo.com www.8bitgo.com tv.8bitgo.com assets.8bitgo.com image.8bitgo.com \
  rom.8bitgo.com download.8bitgo.com roms.8bitgo.com html5.8bitgo.com

api() {
  api_method=$1
  api_path=$2
  if [ "$#" -ge 3 ]; then
    curl -sS -X "$api_method" "https://api.cloudflare.com/client/v4$api_path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' --data "$3"
  else
    curl -sS -X "$api_method" "https://api.cloudflare.com/client/v4$api_path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json'
  fi
}
q() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let j;try{j=JSON.parse(s)}catch(e){console.error('Cloudflare API 返回无效 JSON');process.exit(1)}if(j.success===false){console.error(JSON.stringify(j.errors||j));process.exit(1)};$1})"; }
have=$(api GET "/zones/$ZONE_COM/dns_records?per_page=1000" | q 'console.log(j.result.map(r=>r.type+"|"+r.name+"|"+r.content).join("\n"))')
record_exists() {
  if [ "$#" -ge 3 ]; then record_has_content=1; record_wanted_content=$3
  else record_has_content=0; record_wanted_content=""
  fi
  printf '%s\n' "$have" | node -e '
    let input="";
    process.stdin.on("data", d => input += d).on("end", () => {
      const [type, name, hasContent, content] = process.argv.slice(1);
      const unquote = value => value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
      const found = input.split("\n").some(line => {
        const first = line.indexOf("|");
        const second = line.indexOf("|", first + 1);
        if (first < 0 || second < 0) return false;
        const actualType = line.slice(0, first);
        const actualName = line.slice(first + 1, second);
        const actualContent = line.slice(second + 1);
        return actualType === type && actualName === name &&
          (hasContent !== "1" || unquote(actualContent) === unquote(content));
      });
      process.exit(found ? 0 : 1);
    });
  ' "$1" "$2" "$record_has_content" "$record_wanted_content"
}
add() {
  add_type=$1 add_name=$2 add_content=$3 add_body=$4
  api POST "/zones/$ZONE_COM/dns_records" "$add_body" \
    | q 'console.log("  dns",j.success,j.result?.type||"",j.result?.name||"",j.success?"":JSON.stringify(j.errors))'
  have="${have}${have:+
}${add_type}|${add_name}|${add_content}"
}

for H in "$@"; do
  case "$H" in
    ''|*[!a-z0-9.-]*|.*|*..*|*.) echo "无效主机名：$H" >&2; exit 1 ;;
    8bitgo.com|*.8bitgo.com) ;;
    *) echo "主机名必须属于 8bitgo.com：$H" >&2; exit 1 ;;
  esac
  echo "== $H"
  id=$(api GET "/zones/$ZONE_TOP/custom_hostnames?hostname=$H" | q 'console.log(j.result[0]?.id||"")')
  [ -n "$id" ] || id=$(api POST "/zones/$ZONE_TOP/custom_hostnames" \
    "{\"hostname\":\"$H\",\"ssl\":{\"method\":\"txt\",\"type\":\"dv\",\"settings\":{\"min_tls_version\":\"1.2\"}}}" \
    | q 'if(!j.success){console.error(JSON.stringify(j.errors));process.exit(1)}console.log(j.result.id)')
  tls=$(api GET "/zones/$ZONE_TOP/custom_hostnames/$id" | q 'console.log(j.result.ssl?.settings?.min_tls_version||"")')
  if [ "$tls" != "1.2" ]; then
    api PATCH "/zones/$ZONE_TOP/custom_hostnames/$id" \
      '{"ssl":{"settings":{"min_tls_version":"1.2"}}}' \
      | q 'console.log("  minimum TLS set to 1.2")'
  fi
  ov=$(api GET "/zones/$ZONE_TOP/custom_hostnames/$id" | q 'console.log(j.result.ownership_verification.value)')
  if ! record_exists TXT "_cf-custom-hostname.$H" "$ov"; then
    add TXT "_cf-custom-hostname.$H" "$ov" "{\"type\":\"TXT\",\"name\":\"_cf-custom-hostname.$H\",\"content\":\"\\\"$ov\\\"\",\"ttl\":1,\"comment\":\"8bitgo.top SaaS ownership\"}"
  fi
  case "$TXT_ONLY" in
    *" $H "*)
      v=""; for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
        v=$(api GET "/zones/$ZONE_TOP/custom_hostnames/$id" | q 'console.log((j.result.ssl.validation_records||[]).map(x=>x.txt_value).filter(Boolean).join(" "))')
        [ -n "$v" ] && break; sleep 5; done
      for val in $v; do
        if ! record_exists TXT "_acme-challenge.$H" "$val"; then
          add TXT "_acme-challenge.$H" "$val" "{\"type\":\"TXT\",\"name\":\"_acme-challenge.$H\",\"content\":\"\\\"$val\\\"\",\"ttl\":1,\"comment\":\"8bitgo.top SaaS DCV (TXT, pre-migration)\"}"
        fi
      done ;;
    *)
      if ! record_exists CNAME "_acme-challenge.$H" "$H.$DCV_UUID.dcv.cloudflare.com"; then
        if record_exists CNAME "_acme-challenge.$H"; then
          echo "冲突的 DCV CNAME 已存在：_acme-challenge.$H；请先核对并清理旧记录" >&2
          exit 1
        fi
        add CNAME "_acme-challenge.$H" "$H.$DCV_UUID.dcv.cloudflare.com" "{\"type\":\"CNAME\",\"name\":\"_acme-challenge.$H\",\"content\":\"$H.$DCV_UUID.dcv.cloudflare.com\",\"proxied\":false,\"ttl\":1,\"comment\":\"8bitgo.top SaaS DCV delegation\"}"
      fi ;;
  esac
  echo "  id=$id"
done

echo "== 状态（证书 active 即可；主机名本身要等 DNS 指向 cname.8bitgo.top 才会 active）"
api GET "/zones/$ZONE_TOP/custom_hostnames?per_page=100" | q 'for(const r of j.result)console.log(r.hostname.padEnd(28),"hostname="+r.status,"ssl="+r.ssl?.status)'
