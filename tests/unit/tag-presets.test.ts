import { describe, expect, it } from 'vitest';
import {
  PRESET_TAGS,
  TAG_GROUPS,
  isPresetTag,
  mergeTags,
  parseTagInput,
  toggleTag,
} from '../../src/renderer/src/tag-presets';

/**
 * 预设标签表与三个纯函数：抽屉里点选、自定义输入、以及两者的合并。
 * 标签在数据里只是字符串，所以这里只验证"表的结构"和"合并去重"的行为。
 */
describe('预设标签表', () => {
  it('四组、15 个、没有重复', () => {
    expect(TAG_GROUPS.map((group) => group.name)).toEqual(['学到与想到', '做法', '经历', '生活']);
    expect(PRESET_TAGS).toHaveLength(15);
    expect(new Set(PRESET_TAGS).size).toBe(15);
  });

  it('分组只按一根轴：每组 3–5 个，组内不跨组重复', () => {
    for (const group of TAG_GROUPS) {
      expect(group.tags.length).toBeGreaterThanOrEqual(3);
      expect(group.tags.length).toBeLessThanOrEqual(5);
    }
    expect(PRESET_TAGS).toContain('踩坑');
    expect(isPresetTag('踩坑')).toBe(true);
    expect(isPresetTag('sqlite')).toBe(false);
  });
});

describe('标签输入与合并', () => {
  it('中英文逗号都能分隔，去空白去空项', () => {
    expect(parseTagInput(' sqlite, 备份 ，证书 ,, ')).toEqual(['sqlite', '备份', '证书']);
  });

  it('同一批输入里的重复只留一条', () => {
    expect(parseTagInput('踩坑, 踩坑')).toEqual(['踩坑']);
  });

  it('点选是切换：再点一次取消，顺序按点选先后', () => {
    let tags: string[] = [];
    tags = toggleTag(tags, '踩坑');
    tags = toggleTag(tags, '方法流程');
    expect(tags).toEqual(['踩坑', '方法流程']);
    tags = toggleTag(tags, '踩坑');
    expect(tags).toEqual(['方法流程']);
  });

  it('合并自定义标签时跳过已存在的，不产生重复', () => {
    expect(mergeTags(['踩坑'], ['sqlite', '踩坑', '备份'])).toEqual(['踩坑', 'sqlite', '备份']);
  });
});
