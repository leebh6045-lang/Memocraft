/**
 * 预设标签：应用内置的一份词汇表，创建手记时在「选择标签」抽屉里点选。
 *
 * 手记里存的始终只是字符串标签，预设与自定义在数据上完全等价——
 * 这张表不参与存储，换分类只改这里，不动任何已存的手记。
 */
export interface TagGroup {
  name: string;
  tags: string[];
}

/**
 * 分类只用一根轴：这条手记是什么（想到的 / 要做的 / 发生过的），
 * 加一组生活领域。四组 5+3+4+3，组内同类，不混轴。
 */
export const TAG_GROUPS: TagGroup[] = [
  { name: '学到与想到', tags: ['启发', '涨知识', '参考', '灵感', '疑惑'] },
  { name: '做法', tags: ['方法流程', '清单', '改进'] },
  { name: '经历', tags: ['踩坑', '复盘', '决定', '突发事件'] },
  { name: '生活', tags: ['生活', '情绪', '健康'] },
];

export const PRESET_TAGS: string[] = TAG_GROUPS.flatMap((group) => group.tags);

export function isPresetTag(tag: string): boolean {
  return PRESET_TAGS.includes(tag);
}

/** 逗号分隔（中英文都接受）的手工输入：去空白、去空项、按出现顺序去重。 */
export function parseTagInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/** 切换一个标签：已选则移除，未选则追加在末尾，保持用户选择的顺序。 */
export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag];
}

/** 合并一批新标签：跳过已存在的，其余追加在末尾。 */
export function mergeTags(tags: string[], incoming: string[]): string[] {
  const merged = [...tags];
  for (const tag of incoming) if (!merged.includes(tag)) merged.push(tag);
  return merged;
}
