'use strict';

/**
 * transform.js — 转律态构造与形状归一（纯函数、无 IO）
 *
 * 三个消费者共用，避免各写一份：
 *   - advisor.adviseConversion（转律建议）
 *   - dispose.disposeItem（处置判定：要算「Δ转后」）
 *   - search.searchBestComposition（组合搜索：每件取「原样 / 最优转律后」两态）
 *
 * 口径：转律只改**一条调律位**的词条名，数值按目标词条的区间重取（承音值优先），
 * 其余字段（slot / slotKey / weaponType / uid / 承音 / 定音）原样保留。
 */

import { lookupAffixRange } from './quota.js';

/** 单条转律后的装备件；conversion = { index, to, from? } */
export function transformedItem(item, conversion, affixes) {
  if (!item || !conversion || conversion.index == null) return item;
  const { index, to } = conversion;
  const rr = lookupAffixRange(affixes, to);
  const 数值 = rr ? (rr.承音 ?? rr.max) : (item?.调律?.[index]?.数值 ?? 0);
  return {
    ...item,
    调律: (item?.调律 || []).map((t, i) => (i === index ? { ...(t || {}), 属性: to, 数值 } : t)),
    转律源: item?.调律?.[index]?.属性 ?? null,
  };
}

/**
 * 任意形状 → gradeItem / stateOf 的入参形状 { weaponType, initial, tunings[], converted[], dingyin }。
 * 同时容忍两类输入：装备件（初始:{属性} / 调律:[{属性}]）与已归一的评价对象（initial / tunings）。
 */
export function toGradeShape(piece) {
  if (!piece) return { weaponType: '', initial: undefined, tunings: [], converted: [] };
  if (piece.initial !== undefined || piece.tunings !== undefined) {
    return {
      weaponType: piece.weaponType || '',
      initial: piece.initial,
      tunings: piece.tunings || [],
      converted: piece.converted || [],
      dingyin: piece.dingyin,
    };
  }
  return {
    weaponType: piece.weaponType || '',
    initial: piece?.初始?.属性,
    tunings: (piece?.调律 || []).map((t) => t?.属性),
    converted: (piece?.调律 || []).map((t) => !!t?.转律),
    dingyin: piece?.定音?.属性,
  };
}
