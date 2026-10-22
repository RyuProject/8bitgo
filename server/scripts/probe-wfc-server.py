#!/usr/bin/env python3
"""自建 WFC 服务验收：在 8bitgo 生产机上运行（中继就是从这里连 WFC 的）。
用法：python3 server/scripts/probe-wfc-server.py 103.242.13.112
"""
import os, random, socket, struct, sys, time

DNS = sys.argv[1] if len(sys.argv) > 1 else "103.242.13.112"
GAME = "cod5victoryds"
results = []

def report(ok, label, detail=""):
    results.append(ok)
    print(f"{'OK  ' if ok else 'FAIL'}  {label}{'：' + detail if detail else ''}", flush=True)

def dns_packet(name):
    return struct.pack(">HHHHHH", random.randint(0, 65535), 0x0100, 1, 0, 0, 0) + \
        b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0\0\1\0\1"

def parse_a(reply, qlen):
    rcode = reply[3] & 15
    ips, at = [], qlen
    for _ in range(struct.unpack(">H", reply[6:8])[0]):
        if at + 12 > len(reply): break
        if reply[at] & 0xC0 == 0xC0: at += 2
        else:
            while at < len(reply) and reply[at]: at += reply[at] + 1
            at += 1
        rtype, _, _, size = struct.unpack(">HHIH", reply[at:at + 10]); at += 10
        if rtype == 1 and size == 4: ips.append(".".join(map(str, reply[at:at + 4])))
        at += size
    return rcode, ips

def dns_udp(name):
    q = dns_packet(name)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    s.sendto(q, (DNS, 53))
    return parse_a(s.recv(2048), len(q))

def dns_tcp(name):
    q = dns_packet(name)
    s = socket.create_connection((DNS, 53), 4); s.settimeout(4)
    s.sendall(struct.pack(">H", len(q)) + q)
    data = b""
    while len(data) < 2 or len(data) < 2 + struct.unpack(">H", data[:2])[0]:
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
    return parse_a(data[2:], len(q))

print(f"== 1. DNS（{DNS}:53）==")
names = {
    "conntest": "conntest.nintendowifi.net",
    "nas": "nas.nintendowifi.net",
    "gpcm": "gpcm.gs.nintendowifi.net",
    "gpsp": "gpsp.gs.nintendowifi.net",
    "available": f"{GAME}.available.gs.nintendowifi.net",
    "master": f"{GAME}.master.gs.nintendowifi.net",
    "ms": f"{GAME}.ms14.gs.nintendowifi.net",
    "natneg1": "natneg1.gs.nintendowifi.net",
    "natneg2": "natneg2.gs.nintendowifi.net",
    "natneg3": "natneg3.gs.nintendowifi.net",
    "gamestats": "gamestats.gs.nintendowifi.net",
    "gamestats2": "gamestats2.gs.nintendowifi.net",
}
ip = {}
for key, name in names.items():
    got = None
    for proto, fn in (("UDP", dns_udp), ("TCP", dns_tcp)):
        try:
            rcode, ips = fn(name)
            report(rcode == 0 and bool(ips), f"DNS {proto} {name}", ",".join(ips) or f"rcode={rcode}")
            got = got or (ips[0] if ips else None)
        except Exception as e:
            report(False, f"DNS {proto} {name}", type(e).__name__)
    ip[key] = got or DNS

def tcp(host, port, send=b"", want=1, timeout=5):
    s = socket.create_connection((host, port), timeout); s.settimeout(timeout)
    if send: s.sendall(send)
    data, end = b"", time.time() + timeout
    while len(data) < want and time.time() < end:
        try: chunk = s.recv(8192)
        except socket.timeout: break
        if not chunk: break
        data += chunk
    s.close()
    return data

print("\n== 2. HTTP / NAS ==")
try:
    r = tcp(ip["conntest"], 80, b"GET / HTTP/1.1\r\nHost: conntest.nintendowifi.net\r\nConnection: close\r\n\r\n", 200)
    head = r.split(b"\r\n\r\n")[0].decode("latin1")
    report(b" 200 " in r[:20] and b"nintendo" in r.lower(), "conntest :80", head.splitlines()[0] if head else "空响应")
except Exception as e:
    report(False, "conntest :80", type(e).__name__)
try:
    r = tcp(ip["nas"], 80, b"GET /ac HTTP/1.1\r\nHost: nas.nintendowifi.net\r\nConnection: close\r\n\r\n", 20)
    report(r.startswith(b"HTTP/1."), "NAS HTTP :80", r.split(b"\r\n")[0].decode("latin1") if r else "空响应")
except Exception as e:
    report(False, "NAS HTTP :80", type(e).__name__)

def client_hello(version):
    body = version + os.urandom(32) + b"\x00" + struct.pack(">H", 4) + b"\x00\x05\x00\x04" + b"\x01\x00"
    hs = b"\x01" + struct.pack(">I", len(body))[1:] + body
    return b"\x16" + version + struct.pack(">H", len(hs)) + hs

# DS 的 NAS 只会 SSL 3.0 / TLS 1.0 + RC4；现代默认配置的 443 会直接拒绝
for label, version in (("SSL 3.0", b"\x03\x00"), ("TLS 1.0", b"\x03\x01")):
    try:
        r = tcp(ip["nas"], 443, client_hello(version), 5)
        if r[:1] == b"\x16" and len(r) > 5 and r[5] == 2:
            report(True, f"NAS HTTPS :443 {label}+RC4", f"ServerHello 版本 {r[9]}.{r[10]}，回 {len(r)} 字节")
        elif r[:1] == b"\x15":
            report(False, f"NAS HTTPS :443 {label}+RC4", f"握手告警 level={r[5]} desc={r[6]}（服务器不接受 DS 的老加密）")
        else:
            report(False, f"NAS HTTPS :443 {label}+RC4", f"{len(r)} 字节 {r[:8].hex()}")
    except Exception as e:
        report(False, f"NAS HTTPS :443 {label}+RC4", type(e).__name__)

print("\n== 3. GameSpy TCP ==")
for label, key, port, expect in (("GP gpcm :29900", "gpcm", 29900, b"\\lc\\1\\challenge\\"),
                                 ("gamestats :29920", "gamestats", 29920, None)):
    try:
        r = tcp(ip[key], port, b"", 10, 5)
        ok = r.startswith(expect) if expect else len(r) > 0
        report(ok, label, f"{len(r)} 字节 {r[:24]!r}")
    except Exception as e:
        report(False, label, type(e).__name__)
for label, key, port in (("GP gpsp :29901", "gpsp", 29901), ("master :28910", "master", 28910)):
    try:
        s = socket.create_connection((ip[key], port), 5); s.close()
        report(True, label, "可连接")
    except Exception as e:
        report(False, label, type(e).__name__)

print("\n== 4. GameSpy UDP（匹配 / NATNEG 靠它）==")
def udp(host, port, pkt):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    s.sendto(pkt, (host, port)); s.sendto(pkt, (host, port))
    return s.recv(2048)
natneg_init = b"\xfd\xfc\x1e\x66\x6a\xb2\x03\x00" + os.urandom(4) + b"\x00\x00\x00" + b"\x00" * 6 + GAME.encode() + b"\x00"
for label, key, port, pkt, check in (
    ("可用性 :27900", "available", 27900, b"\x09\0\0\0\0" + GAME.encode() + b"\0", lambda r: r[:3] == b"\xfe\xfd\x09"),
    ("NATNEG1 :27901", "natneg1", 27901, natneg_init, lambda r: r[:6] == natneg_init[:6] and r[7] == 1),
    ("NATNEG2 :27901", "natneg2", 27901, natneg_init, lambda r: r[:6] == natneg_init[:6] and r[7] == 1),
):
    try:
        r = udp(ip[key], port, pkt)
        report(check(r), label, f"{len(r)} 字节 {r[:12].hex()}")
    except Exception as e:
        report(False, label, type(e).__name__)

print(f"\n合计：{sum(results)}/{len(results)} 通过")
if not all(results):
    # 这支脚本会作为上线闸门使用；只打印失败项却返回成功会让部署错误地继续。
    sys.exit(1)
