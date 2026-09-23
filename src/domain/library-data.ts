/**
 * 数据管理（备份、恢复、导出）的跨层数据形状。
 * 放在 domain 是因为渲染端、shared 契约与存储实现都要用它，
 * 而渲染端与契约不允许依赖 storage 层。
 */

/** 内容统计：备份前确认与恢复后核对都用它。 */
export interface LibraryCounts {
  notes: number;
  topics: number;
  threads: number;
  entries: number;
}

/** 备份结果：目标位置、附件数量与总体积，供界面显示真实的"上次备份"。 */
export interface BackupSummary {
  destination: string;
  createdAt: string;
  attachments: number;
  bytes: number;
}

/** 已校验待应用的恢复：内容统计用于替换前的确认。 */
export interface StagedRestore {
  attachments: number;
  databaseBytes: number;
  counts: LibraryCounts;
}

/** 可读导出结果。 */
export interface ExportSummary {
  notes: number;
  topics: number;
  threads: number;
  entries: number;
  destination: string;
}
