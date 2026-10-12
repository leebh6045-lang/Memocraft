import type { NoteCategory } from './note';

/** 问答只接收本地匹配手记的摘录；分类来自原记录，不由模型补造。 */
export interface NoteSearchHit {
  id: string;
  title: string;
  category: NoteCategory;
  excerpt: string;
  matchedTerms: number;
  updatedAt: string;
}

export interface NoteSearchResult {
  hits: NoteSearchHit[];
  /** 所有有效匹配手记的并集数量，包含被候选上限截掉的手记。 */
  total: number;
}
