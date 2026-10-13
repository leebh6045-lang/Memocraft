import { describe, expect, it } from 'vitest';
import { emptyDraft } from '../../src/domain/note';
import {
  validateDraft,
  validateEntriesQuery,
  validateEntryCreate,
  validateEntryEdit,
  validateIncludeArchived,
  validateNoteReferences,
  validateThreadArchive,
  validateThreadCreate,
  validateThreadEdit,
  validateThreadNotes,
  validateNoteEdit,
  validateSearch,
  validateTopicCreate,
  validateTopicEdit,
  validateTopicNote,
  validateTopicNotes,
} from '../../src/services/validation';

const draft = () => ({ ...emptyDraft('786a261c-669d-4b44-8924-d68c1617d4ad'), body: '  正文\n\n' });

describe('跨进程输入校验', () => {
  it('思绪可以自动保存、正式提交和编辑；非法分类提示当前五类', () => {
    const thought = { ...draft(), category: 'thought' };
    expect(validateDraft(thought).category).toBe('thought');
    expect(validateDraft(thought, true).category).toBe('thought');
    expect(validateNoteEdit({ ...thought, expectedRevision: 1 }).category).toBe('thought');
    expect(() => validateDraft({ ...draft(), category: 'unknown' })).toThrow(
      '请选择收获、思绪、待办、完成、其他。',
    );
  });
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

describe('归纳输入校验', () => {
  const topicId = '5c9f0c62-6f0b-4d3e-9a1f-2f0f0f0f0f0f';
  const noteId = '786a261c-669d-4b44-8924-d68c1617d4ad';

  it('标题去掉两端空白，说明保留原文', () => {
    const created = validateTopicCreate({
      title: '  前端开发  ',
      description: ' 布局与工具链 \n',
      confirmDuplicate: false,
    });
    expect(created.title).toBe('前端开发');
    expect(created.description).toBe(' 布局与工具链 \n');
  });

  it.each([
    { title: '', description: '', confirmDuplicate: false },
    { title: '   ', description: '', confirmDuplicate: false },
    { title: 'x'.repeat(301), description: '', confirmDuplicate: false },
    { title: '标题', description: 'y'.repeat(2001), confirmDuplicate: false },
    { title: '标题', description: false, confirmDuplicate: false },
    { title: '标题', description: '', confirmDuplicate: 'yes' },
    null,
    [],
  ])('拒绝无效的新建输入 %#', (input) => {
    expect(() => validateTopicCreate(input)).toThrow();
  });

  it('编辑要求合法标识与版本', () => {
    expect(
      validateTopicEdit({ id: topicId, title: '标题', description: '', expectedRevision: 1 }),
    ).toEqual({ id: topicId, title: '标题', description: '', expectedRevision: 1 });
    expect(() =>
      validateTopicEdit({ id: 'not-a-uuid', title: '标题', description: '', expectedRevision: 1 }),
    ).toThrow('归纳标识');
    expect(() =>
      validateTopicEdit({ id: topicId, title: '标题', description: '', expectedRevision: -1 }),
    ).toThrow('版本');
  });

  it('收录要求非空手记列表并限制单批数量', () => {
    expect(validateTopicNotes({ topicId, noteIds: [noteId] })).toEqual({
      topicId,
      noteIds: [noteId],
    });
    expect(() => validateTopicNotes({ topicId, noteIds: [] })).toThrow('请选择');
    expect(() =>
      validateTopicNotes({ topicId, noteIds: Array.from({ length: 201 }, () => noteId) }),
    ).toThrow('一次最多收录');
    expect(() => validateTopicNotes({ topicId, noteIds: ['手记'] })).toThrow('手记标识');
  });

  it('移出要求归纳与手记标识都合法', () => {
    expect(validateTopicNote({ topicId, noteId })).toEqual({ topicId, noteId });
    expect(() => validateTopicNote({ topicId: 'x', noteId })).toThrow('归纳标识');
    expect(() => validateTopicNote({ topicId, noteId: 'x' })).toThrow('手记标识');
  });
});

describe('长期事务与动态输入校验', () => {
  const threadId = '7d1c9f52-2f5b-4a1e-8f4b-1c2d3e4f5a6b';
  const entryId = '3f8b1a44-9c2d-4e6f-8a1b-2c3d4e5f6a7b';
  const noteId = '786a261c-669d-4b44-8924-d68c1617d4ad';
  const threadInput = {
    title: '  个人服务器  ',
    description: '说明',
    summary: '概况',
    confirmDuplicate: false,
  };

  it('事务标题去空白，说明与概况保留原文', () => {
    expect(validateThreadCreate(threadInput)).toEqual({
      title: '个人服务器',
      description: '说明',
      summary: '概况',
      confirmDuplicate: false,
    });
  });

  it.each([
    { ...threadInput, title: '   ' },
    { ...threadInput, title: 'x'.repeat(301) },
    { ...threadInput, description: 'y'.repeat(2001) },
    { ...threadInput, summary: 'z'.repeat(4001) },
    { ...threadInput, confirmDuplicate: 'yes' },
    null,
    [],
  ])('拒绝无效的新建事务输入 %#', (input) => {
    expect(() => validateThreadCreate(input)).toThrow();
  });

  it('事务编辑要求合法标识与版本', () => {
    expect(
      validateThreadEdit({
        id: threadId,
        title: '标题',
        description: '',
        summary: '',
        expectedRevision: 1,
      }),
    ).toMatchObject({ id: threadId, expectedRevision: 1 });
    expect(() =>
      validateThreadEdit({
        id: 'x',
        title: '标题',
        description: '',
        summary: '',
        expectedRevision: 1,
      }),
    ).toThrow('事务标识');
    expect(() =>
      validateThreadEdit({
        id: threadId,
        title: '标题',
        description: '',
        summary: '',
        expectedRevision: 0,
      }),
    ).toThrow('版本');
  });

  it('归档要求布尔状态与合法版本', () => {
    expect(validateThreadArchive({ threadId, archived: true, expectedRevision: 2 })).toEqual({
      threadId,
      archived: true,
      expectedRevision: 2,
    });
    expect(() => validateThreadArchive({ threadId, archived: 'yes', expectedRevision: 2 })).toThrow(
      '归档状态',
    );
    expect(() =>
      validateThreadArchive({ threadId, archived: false, expectedRevision: -1 }),
    ).toThrow('版本');
  });

  it('时间线排序只接受两种取值', () => {
    expect(validateEntriesQuery({ threadId, order: 'newest' })).toEqual({
      threadId,
      order: 'newest',
    });
    expect(validateEntriesQuery({ threadId, order: 'oldest' })).toEqual({
      threadId,
      order: 'oldest',
    });
    expect(() => validateEntriesQuery({ threadId, order: 'recent' })).toThrow('时间线排序');
  });

  it('动态要求合法发生时间与非空描述', () => {
    const input = {
      threadId,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '  做了什么  ',
      body: '',
      tags: ['运维', '运维'],
      noteIds: [noteId, noteId],
    };
    expect(validateEntryCreate(input)).toEqual({
      threadId,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '做了什么',
      body: '',
      tags: ['运维'],
      noteIds: [noteId],
    });
    expect(() => validateEntryCreate({ ...input, occurredAt: '昨天' })).toThrow('发生时间');
    expect(() => validateEntryCreate({ ...input, summary: '   ' })).toThrow('请填写动态描述');
    expect(() => validateEntryCreate({ ...input, summary: 'x'.repeat(301) })).toThrow('动态描述');
    expect(() => validateEntryCreate({ ...input, tags: ['x'.repeat(101)] })).toThrow('标签');
    expect(() => validateEntryCreate({ ...input, noteIds: ['手记'] })).toThrow('手记标识');
  });

  it('动态编辑要求合法标识与版本', () => {
    const input = {
      id: entryId,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '动态',
      body: '正文',
      tags: [],
      expectedRevision: 1,
    };
    expect(validateEntryEdit(input)).toMatchObject({ id: entryId, summary: '动态' });
    expect(() => validateEntryEdit({ ...input, id: 'x' })).toThrow('动态标识');
    expect(() => validateEntryEdit({ ...input, expectedRevision: 0 })).toThrow('版本');
  });

  it('事务级关联要求非空手记列表，归档筛选必须是布尔值', () => {
    expect(validateThreadNotes({ threadId, noteIds: [noteId] })).toEqual({
      threadId,
      noteIds: [noteId],
    });
    expect(() => validateThreadNotes({ threadId, noteIds: [] })).toThrow('请选择要关联的手记');
    expect(validateIncludeArchived(true)).toBe(true);
    expect(() => validateIncludeArchived('true')).toThrow('归档筛选');
    expect(validateNoteReferences(noteId)).toBe(noteId);
    expect(() => validateNoteReferences('手记')).toThrow('手记标识');
  });
});
