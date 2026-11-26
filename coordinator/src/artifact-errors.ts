const reasons = {
  denied: '对方未开放此项目的成果', unregistered: '这个任务没有登记此成果', expired: '此成果已过期',
  withdrawn: '此成果未关联开放的待处理项', outside: '成果路径不属于当前项目', special: '只可查看项目内的普通文件',
  too_large: '单个附件不得超过 25 MB', missing: '成果文件不存在或无法读取', changed: '读取过程中附件已变化，请重试',
  unreadable: '对方没有读取此文件的权限',
  catalog: '本机项目列表不可用，请恢复后再上报', web: '此成果是网页链接', busy: '正在传输另一个成果',
  timeout: '取文件超时，请检查对方是否在线后重试', offline: '工作间连接已断开', auth: '对方拒绝了连接凭据',
  checksum: '成果校验失败，请重新获取', capacity: '接收区空间不足', interrupted: '成果传输中断，请重试',
  invalid: '成果文件信息无效'
}
export type ArtifactReason = keyof typeof reasons
export function artifactReason(e: unknown, fallback: ArtifactReason): ArtifactReason {
  const err = e as NodeJS.ErrnoException | undefined
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing'
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return 'unreadable'
  return (Object.keys(reasons) as ArtifactReason[]).find(k => reasons[k] === err?.message) ?? fallback
}
export function reasonText(code: unknown) {
  return typeof code === 'string' && Object.hasOwn(reasons, code) ? reasons[code as ArtifactReason] : reasons.invalid
}
