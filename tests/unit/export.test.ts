import { describe, expect, it } from 'vitest';
import { exportFileName, frontMatter, inlineText } from '../../src/domain/export';

/** 导出文件名与元数据是纯规则，单独验证，不依赖文件系统。 */
describe('导出文件名', () => {
  it('稳定 ID 在前，标题在后，扩展名为 md', () => {
    expect(exportFileName('本地数据库', 'abc-123')).toBe('abc-123-本地数据库.md');
  });

  it('清理 Windows 非法字符与控制字符', () => {
    expect(exportFileName('a<b>c:d"e/f\\g|h?i*j', 'id')).toBe('id-a b c d e f g h i j.md');
    // 控制字符直接剔除，不引入额外空格
    expect(exportFileName('换行\n与制表\t符', 'id')).toBe('id-换行与制表符.md');
  });

  it('标题为空或只有非法字符时仍能靠 ID 定位', () => {
    expect(exportFileName('', 'id')).toBe('id.md');
    expect(exportFileName('   ', 'id')).toBe('id.md');
    expect(exportFileName('///', 'id')).toBe('id.md');
  });

  it('去掉结尾的点与空格，避免在 Windows 上不可写', () => {
    expect(exportFileName('标题...', 'id')).toBe('id-标题.md');
    expect(exportFileName('标题   ', 'id')).toBe('id-标题.md');
  });

  it('过长的标题被截断，但仍保留 ID 前缀', () => {
    const long = '标'.repeat(200);
    const name = exportFileName(long, 'id');
    expect(name.startsWith('id-')).toBe(true);
    expect(name.length).toBeLessThan(80);
  });
});

describe('前置元数据', () => {
  it('单行字段压平换行，数组写成 YAML 列表', () => {
    const text = frontMatter({
      类型: '手记',
      标题: '第一行\n第二行',
      标签: ['sqlite', '备份'],
      空值: '',
      空数组: [],
    });
    expect(text).toContain('标题: 第一行 第二行');
    expect(text).toContain('标签:\n  - sqlite\n  - 备份');
    // 空值不写出字段，避免导出物里出现无意义的空行。
    expect(text).not.toContain('空值');
    expect(text).not.toContain('空数组');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text.endsWith('---\n')).toBe(true);
  });

  it('数组元素里的换行被压平', () => {
    expect(frontMatter({ 收录于: ['归纳\nA'] })).toContain('- 归纳 A');
  });

  it('inlineText 只压平换行并去两端空白', () => {
    expect(inlineText('  a\nb  ')).toBe('a b');
  });
});
