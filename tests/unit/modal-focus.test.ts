// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { useModalFocus } from '../../src/renderer/src/composables/useModalFocus';

const Modal = defineComponent({
  props: { label: { type: String, required: true } },
  setup(props, { slots }) {
    const panel = ref<HTMLElement | null>(null);
    useModalFocus(panel, 'input');
    return () =>
      h('section', { ref: panel, role: 'dialog', 'aria-label': props.label }, [
        h('input', { 'aria-label': `${props.label}输入` }),
        slots.default?.(),
      ]);
  },
});

/** 用真实父子挂载与 inert 表达交互层级；只观察用户最终能输入的位置。 */
const FocusHarness = {
  setup() {
    const searchOpen = ref(false);
    const drawerOpen = ref(false);
    async function openSearchResult() {
      drawerOpen.value = true;
      // 与 App 一致：打开目标对象完成之后，再关闭搜索。
      await nextTick();
      searchOpen.value = false;
    }
    return () =>
      h('div', [
        // jsdom 尚未实现 inert 属性反射，显式增删属性以匹配浏览器 DOM。
        h('main', { inert: searchOpen.value || drawerOpen.value ? '' : undefined }, [
          h(
            'button',
            {
              'aria-label': '搜索入口',
              onClick: () => {
                searchOpen.value = true;
              },
            },
            '搜索',
          ),
          h(
            'button',
            {
              'aria-label': '手记卡片',
              onClick: () => {
                drawerOpen.value = true;
              },
            },
            '打开手记',
          ),
        ]),
        drawerOpen.value
          ? h(
              Modal,
              { label: '抽屉', inert: searchOpen.value ? '' : undefined },
              {
                default: () => [
                  h(
                    'button',
                    {
                      'aria-label': '关闭抽屉',
                      onClick: () => {
                        drawerOpen.value = false;
                      },
                    },
                    '关闭',
                  ),
                  h(
                    'button',
                    {
                      'aria-label': '抽屉内搜索',
                      onClick: () => {
                        searchOpen.value = true;
                      },
                    },
                    '搜索',
                  ),
                ],
              },
            )
          : null,
        searchOpen.value
          ? h(
              Modal,
              { label: '搜索' },
              {
                default: () => [
                  h(
                    'button',
                    {
                      'aria-label': '关闭搜索',
                      onClick: () => {
                        searchOpen.value = false;
                      },
                    },
                    '关闭',
                  ),
                  h(
                    'button',
                    { 'aria-label': '打开搜索结果', onClick: openSearchResult },
                    '打开手记',
                  ),
                ],
              },
            )
          : null,
      ]);
  },
};

let wrapper: VueWrapper | undefined;
let host: HTMLElement | undefined;

function mountHarness() {
  host = document.createElement('div');
  document.body.append(host);
  const mounted = mount(FocusHarness, { attachTo: host });
  wrapper = mounted;
  return mounted;
}

async function click(mounted: VueWrapper, label: string) {
  await mounted.get(`[aria-label="${label}"]`).trigger('click');
  await flushPromises();
}

function focus(mounted: VueWrapper, label: string) {
  const element = mounted.get(`[aria-label="${label}"]`).element;
  if (!(element instanceof HTMLElement)) throw new Error('测试控件必须可以接收焦点。');
  element.focus();
  return element;
}

function expectFocused(mounted: VueWrapper, label: string) {
  expect(document.activeElement).toBe(mounted.get(`[aria-label="${label}"]`).element);
}

afterEach(async () => {
  wrapper?.unmount();
  await nextTick();
  host?.remove();
  wrapper = undefined;
  host = undefined;
});

describe('弹层焦点回到有效的操作来源', () => {
  it('直接关闭搜索后回到搜索入口', async () => {
    const mounted = mountHarness();
    focus(mounted, '搜索入口');
    await click(mounted, '搜索入口');
    expectFocused(mounted, '搜索输入');
    await click(mounted, '关闭搜索');
    expect(mounted.find('[role="dialog"]').exists()).toBe(false);
    expectFocused(mounted, '搜索入口');
  });

  it('搜索打开抽屉后，关闭抽屉仍回到搜索前的来源', async () => {
    const mounted = mountHarness();
    focus(mounted, '搜索入口');
    await click(mounted, '搜索入口');
    const removedSearchInput = focus(mounted, '搜索输入');
    await click(mounted, '打开搜索结果');
    expect(removedSearchInput.isConnected).toBe(false);
    expectFocused(mounted, '抽屉输入');
    await click(mounted, '关闭抽屉');
    expectFocused(mounted, '搜索入口');
  });

  it('抽屉上打开搜索，逐层关闭时依次恢复抽屉输入和原手记卡片', async () => {
    const mounted = mountHarness();
    focus(mounted, '手记卡片');
    await click(mounted, '手记卡片');
    expectFocused(mounted, '抽屉输入');
    await click(mounted, '抽屉内搜索');
    expectFocused(mounted, '搜索输入');
    await click(mounted, '关闭搜索');
    expectFocused(mounted, '抽屉输入');
    await click(mounted, '关闭抽屉');
    expectFocused(mounted, '手记卡片');
  });
});
