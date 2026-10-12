<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import type { AiPeriodType } from '../../../shared/ai';
import type { ReviewPeriodOption } from '../composables/useReview';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  startDate: string;
  label: string;
  periodType: AiPeriodType;
  options: readonly ReviewPeriodOption[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ select: [startDate: string] }>();
const listId = useId();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const focusedIndex = ref(0);

function closeDropdown(restoreFocus = true): void {
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}

function focusOption(index: number): void {
  const options = menu.value?.querySelectorAll<HTMLButtonElement>('[role="option"]');
  if (!options?.length) return;
  focusedIndex.value = Math.max(0, Math.min(index, options.length - 1));
  options[focusedIndex.value]?.focus({ preventScroll: true });
  options[focusedIndex.value]?.scrollIntoView?.({ block: 'nearest' });
}

async function openDropdown(): Promise<void> {
  if (props.disabled || !props.options.length || open.value) return;
  focusedIndex.value = 0;
  open.value = true;
  await nextTick();
  // 等待挂载期间可能切页或关闭，旧的展开操作不能抢回焦点。
  if (open.value) focusOption(0);
}

function toggleDropdown(): void {
  if (open.value) closeDropdown();
  else void openDropdown();
}

function selectPeriod(startDate: string): void {
  if (!open.value || props.disabled) return;
  closeDropdown();
  emit('select', startDate);
}

function triggerKeydown(event: KeyboardEvent): void {
  if (event.isComposing || props.disabled) return;
  // Shift+Tab 可从列表回到触发按钮，展开状态下仍须能关闭或重新进入列表。
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    closeDropdown();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (open.value) focusOption(focusedIndex.value);
    else void openDropdown();
  }
}

function menuKeydown(event: KeyboardEvent): void {
  if (event.isComposing || !open.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeDropdown();
    return;
  }
  let index: number;
  if (event.key === 'ArrowDown') index = focusedIndex.value + 1;
  else if (event.key === 'ArrowUp') index = focusedIndex.value - 1;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = props.options.length - 1;
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = props.options[focusedIndex.value];
    if (option) selectPeriod(option.startDate);
    return;
  } else return;
  event.preventDefault();
  focusOption(index);
}

function focusout(event: FocusEvent): void {
  // Tab 沿正常文档顺序离开，关闭菜单时不把已离开的焦点拉回来。
  if (event.relatedTarget instanceof Node && !root.value?.contains(event.relatedTarget))
    closeDropdown(false);
}

/** 离场列表只作视觉过渡，不再参与键盘操作或重复播报。 */
function disableLeavingMenu(element: Element): void {
  if (element instanceof HTMLElement) {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
}

function enableEnteringMenu(element: Element): void {
  if (element instanceof HTMLElement) {
    element.inert = false;
    element.removeAttribute('aria-hidden');
  }
}

watch(
  () => [props.startDate, props.periodType, props.options, props.disabled],
  () => {
    if (!open.value) return;
    const focusInMenu = menu.value?.contains(document.activeElement) ?? false;
    closeDropdown(focusInMenu && !props.disabled);
  },
);
</script>

<template>
  <div ref="root" class="period-picker" @focusout="focusout">
    <div v-if="open" class="period-backdrop" aria-hidden="true" @click="closeDropdown()" />
    <button
      ref="trigger"
      type="button"
      class="period-trigger"
      :aria-label="`选择回顾时间段：${label}`"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :disabled="disabled"
      @click="toggleDropdown"
      @keydown="triggerKeydown"
    >
      <span class="period-heading">
        <Transition name="review-heading" mode="out-in">
          <span :key="`${periodType}:${startDate}`" class="period-label">{{ label }}</span>
        </Transition>
      </span>
      <AppIcon name="chevron" class="icon-s period-chevron" :class="{ expanded: open }" />
    </button>
    <Transition
      name="period-menu"
      @before-enter="enableEnteringMenu"
      @before-leave="disableLeavingMenu"
    >
      <div
        v-if="open"
        :id="listId"
        ref="menu"
        class="period-menu"
        role="listbox"
        aria-label="选择回顾时间段"
        @keydown="menuKeydown"
      >
        <button
          v-for="(option, index) in options"
          :key="option.startDate"
          type="button"
          class="period-option"
          role="option"
          :data-start-date="option.startDate"
          :aria-selected="option.startDate === startDate"
          :tabindex="index === focusedIndex ? 0 : -1"
          @focus="focusedIndex = index"
          @click="selectPeriod(option.startDate)"
        >
          <span class="period-check" aria-hidden="true">
            <AppIcon v-if="option.startDate === startDate" name="check" class="icon-s" />
          </span>
          <span class="period-option-label">{{ option.label }}</span>
          <span v-if="option.isCurrent" class="period-current">
            本{{ periodType === 'week' ? '周' : '月' }}
          </span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.period-picker {
  position: relative;
  z-index: 20;
  width: fit-content;
  max-width: 100%;
}
.period-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1;
}
.period-trigger {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 4px 0;
  color: var(--text);
  text-align: left;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.8;
  transition: color var(--dur-1) ease;
}
.period-trigger:hover:enabled {
  color: var(--accent);
}
.period-heading {
  display: grid;
  min-width: 0;
  min-height: 27px;
}
.period-label {
  overflow-wrap: anywhere;
}
.period-chevron {
  flex: none;
  color: var(--muted);
  transition: transform var(--dur-2) var(--ease);
}
.period-chevron.expanded {
  transform: rotate(180deg);
}
.period-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 2;
  width: max-content;
  min-width: 100%;
  max-width: min(440px, calc(100vw - 64px));
  max-height: min(320px, calc(100vh - 230px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.period-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 8px;
  border-radius: var(--radius-s);
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  text-align: left;
  transition: background-color var(--dur-1) ease;
}
.period-option:hover,
.period-option:focus-visible {
  background: var(--surface-2);
}
.period-check {
  display: grid;
  place-items: center;
  width: 16px;
  flex: none;
  color: var(--accent);
}
.period-option-label {
  flex: 1;
  overflow-wrap: anywhere;
}
.period-current {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}
.review-heading-enter-active {
  transition:
    opacity var(--dur-2) ease,
    transform var(--dur-2) var(--ease);
}
.review-heading-leave-active {
  transition:
    opacity var(--dur-1) ease,
    transform var(--dur-1) var(--ease);
}
.review-heading-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.review-heading-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.period-menu-enter-active {
  transition:
    opacity var(--dur-2) ease,
    transform var(--dur-2) var(--ease-out);
}
.period-menu-leave-active {
  pointer-events: none;
  transition: opacity var(--dur-1) ease;
}
.period-menu-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}
.period-menu-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .period-chevron,
  .period-menu-enter-active,
  .period-menu-leave-active,
  .review-heading-enter-active,
  .review-heading-leave-active {
    transition: none;
  }
  .period-menu-enter-from,
  .review-heading-enter-from,
  .review-heading-leave-to {
    opacity: 1;
    transform: none;
  }
}
</style>
