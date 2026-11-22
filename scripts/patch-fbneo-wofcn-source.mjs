#!/usr/bin/env node
/**
 * 给 wofcn 专用 FBNeo 核心保留隔离字库，并仅在人物对白区重映射字码。
 * 只有 ZipName=wofcn 且基础驱动为 wofj 时生效，不改默认核心和其他语言。
 * 用法：node scripts/patch-fbneo-wofcn-source.mjs <FBNeo 源码目录>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('用法：node scripts/patch-fbneo-wofcn-source.mjs <FBNeo 源码目录>')
const sourceRoot = resolve(root)

function edit(relativePath, transform) {
  const path = join(sourceRoot, relativePath)
  const before = readFileSync(path, 'utf8')
  const after = transform(before)
  if (after !== before) writeFileSync(path, after)
}

function insertOnce(source, anchor, addition, description) {
  if (source.includes(addition.trim())) return source
  const first = source.indexOf(anchor)
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${description} 的上游位置变化，停止打补丁`)
  }
  const offset = first + anchor.length
  return source.slice(0, offset) + addition + source.slice(offset)
}

function replaceOnce(source, before, after, description) {
  if (source.includes(after)) return source
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${description} 的上游位置变化，停止打补丁`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

edit('src/burn/drv/capcom/cps.h', (source) => {
  source = source.replace(/^#define mapper_WOFCN[^\n]*\n/gm, '')
  source = source.replace(/\nextern INT32 GfxRomBankIsWofcnFont\(INT32 Tile\);\n/g, '\n')
  if (!source.includes('extern INT32 IsWofcnRomData();')) {
    source = insertOnce(source, 'extern INT32 GfxRomBankMapper(INT32 Type, INT32 Code);', '\nextern INT32 IsWofcnRomData();', 'WOF CN ROM 专属判定声明')
  }
  return source
})

edit('src/burn/drv/capcom/cps_config.cpp', (source) => {
  // 复用的构建目录可能残留早期逐 tile 调试代码；它会在每帧向控制台写大量日志。
  source = source.replace(/\n#ifdef __EMSCRIPTEN__\n\s*EM_ASM\(\{\s*if \(\$0 === 2\) \{[\s\S]*?console\.log\('\[WOFCN_MAP\]'[\s\S]*?\n\s*\}, Type, Code, IsWofcnRomData\(\)\);\n#endif\n/g, '\n')
  source = source.replace(/static const struct GfxRange mapper_WOFCN_table\[\] = \{[\s\S]*?\n\};\n\n/g, '')
  source = source.replace(/\t\tcase mapper_WOFCN: \{[\s\S]*?\n\t\t\}\n\n/g, '')
  source = source.replace(/\n\tif \(GfxBankMapper == mapper_WOFCN_table && Type == GFXTYPE_SCROLL1\) \{[\s\S]*?\n\t\}\n/g, '\n')
  source = source.replace(/\t\/\/ 字库 ROM 只替代汉化程序实际引用的两个 scroll1 tile 段[\s\S]*?\n\t\}\n\n/g, '')
  source = source.replace(/\n\t\/\/ WOF CN 的两段剧情文字[\s\S]*?\n\t\}\n/g, '')
  source = source.replace(/\n\t\/\/ wofcn 的汉化 tile 走独立扩展区[\s\S]*?\n\t\}\n/g, '\n')
  source = source.replace(/\n\t\/\/ wofcn 的开场与人物对白各占 0x800 个 tile[\s\S]*?\n\t\}\n/g, '\n')
  // 旧实验曾把对白折到 0x4000、只映射到 0xe7ff，或重复插入完整映射；按标记清理后再统一写入。
  source = source.replace(/\n\t\/\/ (?:wofj 的 0x4fff 掩码会把人物对白 0xe000 折成 0x4000；在掩码后地址映射回同一字库。|wofcn 的两段文字窗口共用同一份 0x800 tile 字库，不能越过扩展区末尾。|wofcn 的对白高位地址与低位窗口共用 0x800 tile 字库。|wofcn 的高位对白地址 0xe800-0xefff 复用 0xe000-0xe7ff 的字库窗口。|wofcn 的剧情文字地址共用 0x800 tile 字库，避免回落到普通场景图形。)[\s\S]*?\n\t\}\n/g, '\n')
  source = source.replace(/\n\t\/\/ wofcn 人物对白的高位地址复用 0x800 tile 字库窗口。\n\tif \(IsWofcnRomData\(\) && Type == GFXTYPE_SCROLL1\) \{\n\t\tif \(Code >= 0x1000 && Code <= 0x17ff\) return 0x10000 \+ \(Code - 0x1000\);\n\t\tif \(Code >= 0xe000 && Code <= 0xefff\) return 0x10000 \+ \(\(Code - 0xe000\) & 0x7ff\);\n\t\}\n/g, '\n')
  // HBMAME 的 wofcn ROM_COPY 目标落在标准 tile 窗口 0x040000 / 0x380000，
  // 让通用 mapper 按原地址读取；不可把原 tile code 折叠到扩展 bank。
  return source
})

edit('src/burn/drv/capcom/cps_scr.cpp', (source) => {
  // 清理复用构建目录时遗留的调试浮层和旧版映射，避免临时实验进入交付核心。
  source = source.replace(/\n#ifdef __EMSCRIPTEN__\n#include <emscripten\/em_asm\.h>\n#endif\n/g, '\n')
  source = source.replace(/\n#ifdef __EMSCRIPTEN__\n[\s\S]*?\n#endif\n/g, (block) => block.includes('WOFCN') || block.includes('wofcn') ? '\n' : block)
  source = source.replace(/\n\s*\/\/ (?:临时记录实机对白格|ROM 专属判断加对白窗口坐标|对白字库只在对白窗口|对白区使用独立字库)[\s\S]*?\n\s*\}\n/g, '\n')
  source = source.replace(/\n\s*if \(GfxRomBankIsWofcnFont\(t(?: >> 6)?\) && \(fx & 1\)\) t \+= 4;/g, '')
  source = source.replace(/\n\s*\/\/ CPS1 字库 ROM 的一个 tile code[\s\S]*?if \(t >= 0x400000 && t < 0x420000 && \(fx & 1\)\) t \+= 4;\n/g, '\n')
  source = source.replace(/\n\s*\/\/ FBNeo 每个 8x8 tile 的行宽是 8 字节[\s\S]*?\n\s*if \(IsWofcnRomData\(\) && t >= 0x400000 && t < 0x420000 && !?\(fx & 1\)\) t \+= 4;\n/g, '\n')
  source = source.replace(/\n\s*if \(IsWofcnRomData\(\) && t >= 0x400000 && t < 0x420000 && !?\(fx & 1\)\) t \+= 4;\n/g, '\n')
  source = source.replace(/\n\s*INT32 wofcnRawTile;\n/g, '\n')
  source = source.replace(/\n\s*wofcnRawTile = t;\n/g, '\n')

  const drawStart = source.indexOf('INT32 Cps1Scr1Draw(')
  const drawEnd = source.indexOf('\nINT32 Cps2Scr1Draw(', drawStart)
  if (drawStart < 0 || drawEnd < 0) throw new Error('找不到 CPS1 scroll tile 绘制函数')
  let draw = source.slice(drawStart, drawEnd)
  draw = draw.replace(/INT32 t,?\s*a;\n\s*UINT16 \*pst;/, 'INT32 t,a,rawCode;\n      UINT16 *pst;')
  if (!draw.includes('t = BURN_ENDIAN_SWAP_INT16(pst[0]);\n      rawCode = t;')) {
    draw = draw.replace(/t = BURN_ENDIAN_SWAP_INT16\(pst\[0\]\);/, 't = BURN_ENDIAN_SWAP_INT16(pst[0]);\n      rawCode = t;')
  }
  draw = draw.replace(/\n\s*rawCode = t;(?=\n\s*t = GfxRomBankMapper)/, '')

  const mapBlock = /\n\s*if \(Scroll1TileMask\) t &= Scroll1TileMask;[\s\S]*?\n\s*a = BURN_ENDIAN_SWAP_INT16\(pst\[1\]\);/
  const mapped = [
    '\n      if (Scroll1TileMask) t &= Scroll1TileMask;',
    '      t = GfxRomBankMapper(GFXTYPE_SCROLL1, t);',
    '      if (t == -1) continue;',
    '      t<<=6; // Get real tile address',
    '      t+=nCpsGfxScroll[1]; // add on offset to scroll tiles',
    '      a = BURN_ENDIAN_SWAP_INT16(pst[1]);',
    '      // 原始字码必须在 ROM 掩码前保存；只替换 wofcn 对白，不碰其他场景图块。',
    '      if (IsWofcnRomData() && rawCode >= 0xe000 && rawCode <= 0xefff &&',
    '          (a & 0x1f) == 16 &&',
    '          sx + (x << 3) >= 72 && sx + (x << 3) < 360 &&',
    '          sy + (y << 3) >= 32 && sy + (y << 3) < 120) {',
    '        t = ((0x10000 + (rawCode & 0x07ff)) << 6) + nCpsGfxScroll[1];',
    '      }',
    '      if (t==nKnowBlank) continue; // Don\'t draw: we know it\'s blank',
  ].join('\n')
  if (mapBlock.test(draw)) draw = draw.replace(mapBlock, mapped)
  else if (!draw.includes('rawCode & 0x07ff')) throw new Error('CPS1 scroll tile 绘制位置已变化，停止添加 WOF CN 字库映射')
  source = source.slice(0, drawStart) + draw + source.slice(drawEnd)
  return source
})

edit('src/burn/drv/capcom/d_cps1.cpp', (source) => {
  source = source.replace(/\n\t\tif \(pDataRomDesc && pRDI && pRDI->nDescCount >= 0 &&\n\t\t\tstrcmp\(pRDI->szZipName, "wofcn"\) == 0 && strcmp\(GameName, "wofj"\) == 0\) \{\n\t\t\tSetGfxMapper\(mapper_WOFCN\);\n\t\t\}\n/g, '')
  source = source.replace(/\n\t\t\/\/ (?:wofcn 的扩展字库保留在独立 bank，原图形窗口不被覆盖。|扩展字库单独分配在图形区后，避免改变 CPS1 的原始图形掩码。)\n\t\t(?:if \(IsWofcnRomData\(\)\) nCpsGfxLen \+= nCpsExtraGfxLen|nCpsGfxExtraLen = IsWofcnRomData\(\) \? nCpsExtraGfxLen : 0);/g, '')
  source = source.replace(/static INT32 IsWofcnRomData\(\)/, 'INT32 IsWofcnRomData()')
  const helper = 'INT32 IsWofcnRomData()\n{\n'
    + '\treturn pDataRomDesc && pRDI && pRDI->nDescCount >= 0 &&\n'
    + '\t\tstrcmp(pRDI->szZipName, "wofcn") == 0 && strcmp(pRDI->szDrvName, "wofj") == 0;\n'
    + '}\n\n'
  if (!source.includes('INT32 IsWofcnRomData()')) {
    source = insertOnce(source, 'static char* szGameName = NULL;\n\n', helper, 'WOF CN ROM 专属判定')
  }

  const reserveAnchor = '\t\tnCpsExtraGfxLen\t+= CRI.nCpsExtraGfxLen;'
  const reserve = '\n\n\t\t// 扩展字库单独分配，剧情外的场景图形不会被覆盖。\n'
    + '\t\tif (IsWofcnRomData()) nCpsGfxLen += nCpsExtraGfxLen;'
  if (!source.includes('if (IsWofcnRomData()) nCpsGfxLen += nCpsExtraGfxLen;')) {
    source = insertOnce(source, reserveAnchor, reserve, 'WOF CN 扩展图形内存预留')
  }

  const extraTilesAnchor = '\t\t\t\t\tCpsLoadTiles(CpsGfx + 0x400000, i);\n\t\t\t\t\n\t\t\t\t\ti += 4;'
  const fontLoad = '\t\t\t\t\tCpsLoadTiles(CpsGfx + 0x400000, i);\n'
    + '\t\t\t\t\ti += 4;'
  source = source.replace(/\n\t\t\t\t\tif \(IsWofcnRomData\(\)\) \{[\s\S]*?memcpy\(CpsGfx \+ 0x(?:040000|380000),[\s\S]*?\n\t\t\t\t\t\}\n/g, '\n')
  if (source.includes(extraTilesAnchor)) source = replaceOnce(source, extraTilesAnchor, fontLoad, 'WOF CN 扩展字库 loader')
  else if (!source.includes(fontLoad)) throw new Error('WOF CN 扩展图形 loader 已变化，停止添加字体加载')

  // 清理旧试验中将字库覆盖进普通 tile 地址的代码。
  source = source.replace(/\n\t\/\/ HBMAME tk2h5 将字库复制到 tile 0x1000[\s\S]*?\n\t\}\n/g, '\n')

  source = source.replace(/\n\t\t\t\/\/ HBMAME 将解码后的中文字库[\s\S]*?\n\t\t\t\}\n/g, '\n')
  return source
})

console.log(`已为 wofcn 专用 FBNeo 核心添加对白专属字库映射：${sourceRoot}`)
