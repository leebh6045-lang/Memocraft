import { describe, expect, it } from 'vitest';
import { emptyDraft } from '../../src/domain/note';
import { validateDraft, validateNoteEdit, validateSearch } from '../../src/services/validation';

const draft = () => ({ ...emptyDraft('786a261c-669d-4b44-8924-d68c1617d4ad'), body: '  正文\n\n' });

describe('跨进程输入校验', () => {
  it('保留正文原文，并允许自动保存空草稿', () => {
    expect(validateDraft(draft(), true).body).toBe('  正文\n\n');
    expect(validateDraft({ ...draft(), body: '' }).body).toBe('');
  });
  it('正式提交与编辑拒绝只有空白的正文', () => {
    expect(() => validateDraft({ ...draft(), body: ' \n\t' }, true)).toThrow('正文');
    expect(() => validateNoteEdit({ ...draft(), body: '', expectedRevision: 0 })).toThrow('正文');
  });
  it.each([
    null,
    [],
    {},
    { ...draft(), id: '../escape' },
    { ...draft(), revision: -1 },
    { ...draft(), revision: 1.5 },
    { ...draft(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...draft(), category: 'open' },
    { ...draft(), extrasOpen: 'false' },
  ])('拒绝非法结构、标识、版本及分类 %#', (input) => {
    expect(() => validateDraft(input)).toThrow();
  });
  it('限制 UTF-8 正文字节数和输入规模', () => {
    expect(() => validateDraft({ ...draft(), body: '中'.repeat(700_000) })).toThrow('2 MB');
    expect(() => validateDraft({ ...draft(), title: 'a'.repeat(301) })).toThrow('300');
    expect(() => validateDraft({ ...draft(), tags: Array<string>(101).fill('a') })).toThrow('100');
    expect(() => validateDraft({ ...draft(), tags: [' '] })).toThrow('标签');
    expect(validateDraft({ ...draft(), tags: [' a ', 'a', '中文'] }).tags).toEqual(['a', '中文']);
  });
  it('搜索按文本传递符号，拒绝无效输入', () => {
    expect(validateSearch('  100%_证书  ')).toBe('100%_证书');
    expect(() => validateSearch({ query: 'a' })).toThrow();
    expect(() => validateSearch('a'.repeat(501))).toThrow('500');
  });
});
