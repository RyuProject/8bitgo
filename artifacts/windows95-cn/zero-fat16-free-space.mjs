#!/usr/bin/env node
/**
 * 把 MBR 第一分区里的 FAT16 空闲簇抹成零。
 *
 * 删除 Windows 安装缓存只会释放 FAT 项，原数据仍留在扇区里；若直接转 QCOW2，
 * 这些无用字节仍会占下载体积。这里只写 FAT 明确标记为 0 的簇，已占用簇不碰。
 */
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs'

const [imagePath] = process.argv.slice(2)
if (!imagePath) {
  console.error('用法：node zero-fat16-free-space.mjs <MBR 磁盘镜像.raw>')
  process.exit(2)
}

const fd = openSync(imagePath, 'r+')
try {
  const sector0 = Buffer.alloc(512)
  if (readSync(fd, sector0, 0, sector0.length, 0) !== sector0.length) throw new Error('无法读取 MBR')
  if (sector0.readUInt16LE(510) !== 0xaa55) throw new Error('MBR 签名错误')

  const partitionType = sector0[446 + 4]
  if (partitionType !== 0x04 && partitionType !== 0x06 && partitionType !== 0x0e) {
    throw new Error(`第一分区不是 FAT16（类型 0x${partitionType.toString(16)}）`)
  }
  const partitionLba = sector0.readUInt32LE(446 + 8)
  const partitionSectors = sector0.readUInt32LE(446 + 12)
  if (!partitionLba || !partitionSectors) throw new Error('第一分区范围无效')
  const partitionOffset = partitionLba * 512

  const boot = Buffer.alloc(512)
  if (readSync(fd, boot, 0, boot.length, partitionOffset) !== boot.length) throw new Error('无法读取 FAT 引导扇区')
  if (boot.readUInt16LE(510) !== 0xaa55) throw new Error('FAT 引导扇区签名错误')
  const bytesPerSector = boot.readUInt16LE(11)
  const sectorsPerCluster = boot[13]
  const reservedSectors = boot.readUInt16LE(14)
  const fatCount = boot[16]
  const rootEntries = boot.readUInt16LE(17)
  const totalSectors = boot.readUInt16LE(19) || boot.readUInt32LE(32)
  const sectorsPerFat = boot.readUInt16LE(22)
  if (bytesPerSector !== 512 || !sectorsPerCluster || fatCount !== 2 || !sectorsPerFat) {
    throw new Error('只处理 512 字节扇区、双 FAT 的 FAT16 镜像')
  }
  if (totalSectors !== partitionSectors) throw new Error('BPB 与 MBR 的分区大小不一致')
  const rootDirSectors = Math.ceil(rootEntries * 32 / bytesPerSector)
  const firstDataSector = reservedSectors + fatCount * sectorsPerFat + rootDirSectors
  const clusterBytes = sectorsPerCluster * bytesPerSector
  const clusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster)
  if (clusterCount < 4085 || clusterCount >= 65525) throw new Error('簇数量不属于 FAT16 范围')

  const fatBytes = sectorsPerFat * bytesPerSector
  const fatA = Buffer.alloc(fatBytes)
  const fatB = Buffer.alloc(fatBytes)
  const fatAOffset = partitionOffset + reservedSectors * bytesPerSector
  const fatBOffset = fatAOffset + fatBytes
  readSync(fd, fatA, 0, fatBytes, fatAOffset)
  readSync(fd, fatB, 0, fatBytes, fatBOffset)
  if (!fatA.equals(fatB)) throw new Error('两份 FAT 不一致，拒绝在可能损坏的镜像上写入')

  const diskSize = fstatSync(fd).size
  const partitionEnd = partitionOffset + partitionSectors * bytesPerSector
  if (partitionEnd > diskSize) throw new Error('分区超出镜像末尾')
  const firstDataOffset = partitionOffset + firstDataSector * bytesPerSector
  const zero = Buffer.alloc(clusterBytes)
  let freeClusters = 0
  for (let cluster = 2; cluster < clusterCount + 2; cluster++) {
    if (fatA.readUInt16LE(cluster * 2) !== 0) continue
    const at = firstDataOffset + (cluster - 2) * clusterBytes
    if (at + clusterBytes > partitionEnd) throw new Error('空闲簇位置超出分区')
    writeSync(fd, zero, 0, zero.length, at)
    freeClusters++
  }
  console.log(`已抹零 ${freeClusters} 个空闲簇（${(freeClusters * clusterBytes / 1048576).toFixed(2)} MiB）`)
} finally {
  closeSync(fd)
}
