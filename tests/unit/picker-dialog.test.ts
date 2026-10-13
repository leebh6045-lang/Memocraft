// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import PickerDialog from '../../src/renderer/src/components/PickerDialog.vue';

const wrappers: VueWrapper[] = [];

function render(options = [{ id: 'topic-1', title: '数据库', searchText: '数据库', meta: '' }]) {
  const wrapper = mount(PickerDialog, {
    attachTo: document.body,
    props: {
      title: '收录到归纳',
      hint: '选择归纳',
      options,
      searchLabel: '搜索归纳',
      searchPlaceholder: '搜索归纳标题',
      linkedCount: 0,
      emptyText: '还没有归纳，可以先新建一个。',
      searchEmptyText: '没有找到匹配的归纳，换个词试试。',
      allLinkedText: '全部归纳都已收录。',
      unit: '个',
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

describe('选择器的空状态', () => {
  it('搜索无命中不误称归纳不存在，清空搜索后恢复候选和选择', async () => {
    const wrapper = render();
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error('选择器没有打开');
    const input = dialog.querySelector('input[type="search"]');
    const checkbox = dialog.querySelector('input[type="checkbox"]');
    if (!(input instanceof HTMLInputElement) || !(checkbox instanceof HTMLInputElement))
      throw new Error('选择器输入未出现');
    checkbox.click();
    await wrapper.vm.$nextTick();
    input.value = '不存在的主题';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(dialog.textContent).toContain('没有找到匹配的归纳，换个词试试。');
    expect(dialog.textContent).not.toContain('还没有归纳');
    expect(wrapper.emitted('confirm')).toBeUndefined();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(dialog.textContent).toContain('数据库');
    expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it('无查询时区分真正空库与全部已关联，有查询时只说明本次搜索', async () => {
    const wrapper = render([]);
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error('选择器没有打开');
    expect(dialog.textContent).toContain('还没有归纳，可以先新建一个。');
    await wrapper.setProps({ linkedCount: 1 });
    expect(dialog.textContent).toContain('全部归纳都已收录。');
    const input = dialog.querySelector('input[type="search"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('搜索输入未出现');
    input.value = '查找';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(dialog.textContent).toContain('没有找到匹配的归纳，换个词试试。');
    expect(dialog.textContent).not.toContain('全部归纳都已收录');
  });
});
