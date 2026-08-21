/**
 * The relation classifier (#58 rule 7).
 *
 * Table-driven, in both languages the catalogue is written in, and with the NEAR
 * MISSES beside the hits: a classifier tested only on positives cannot tell a
 * working word-boundary match from a substring match that fires on `backpack`.
 */

import { describe, expect, it } from 'vitest';
import {
  detectPackCount,
  detectRelation,
  relationTokens,
  type SubjectRelation,
} from '../relation-detection.js';

interface Row {
  readonly title: string;
  readonly expected: SubjectRelation;
  readonly why: string;
}

const CASES: readonly Row[] = [
  // ── base: the ordinary product ─────────────────────────────────────────────
  { title: 'Apple iPhone 15 Pro 256GB', expected: 'base', why: 'a plain product' },
  { title: 'Bombilla LED E27 9W', expected: 'base', why: 'a plain product, Spanish' },
  {
    title: 'iPhone 15 Pro compatible con MagSafe',
    expected: 'accessory',
    why: 'a bare compatibility claim is the only signal, so it promotes',
  },

  // ── accessory ──────────────────────────────────────────────────────────────
  { title: 'Funda de silicona para iPhone 15 Pro', expected: 'accessory', why: 'funda' },
  { title: 'Silicone Case for iPhone 15 Pro', expected: 'accessory', why: 'case' },
  { title: 'Carcasa transparente iPhone 15', expected: 'accessory', why: 'carcasa' },
  {
    title: 'Protector de pantalla cristal templado',
    expected: 'accessory',
    why: 'protector de pantalla',
  },
  { title: 'Cargador USB-C 20W', expected: 'accessory', why: 'cargador' },
  { title: 'Correa deportiva Apple Watch', expected: 'accessory', why: 'correa' },
  { title: 'Soporte de coche para movil', expected: 'accessory', why: 'soporte' },

  // ── replacement part: beats accessory, and that ordering is deliberate ──────
  { title: 'Bateria de repuesto para iPhone 15 Pro', expected: 'replacement_part', why: 'repuesto' },
  {
    title: 'Replacement charging cable for iPhone',
    expected: 'replacement_part',
    why: 'a part beats an accessory: it is a part OF the product, not for it',
  },
  { title: 'Recambio de filtro aspiradora', expected: 'replacement_part', why: 'recambio' },

  // ── multipack ──────────────────────────────────────────────────────────────
  { title: 'Bombilla LED E27 9W pack de 6', expected: 'multipack', why: 'pack de N' },
  { title: 'AA Batteries pack of 12', expected: 'multipack', why: 'pack of N' },
  { title: 'Pilas AA 4 unidades', expected: 'multipack', why: 'N unidades' },
  { title: 'Calcetines negros x3', expected: 'multipack', why: 'xN' },
  { title: 'Bombillas LED twin pack', expected: 'multipack', why: 'a multipack marker with no count' },

  // ── bundle ─────────────────────────────────────────────────────────────────
  { title: 'Meta Quest 3 bundle con Asgard Wrath 2', expected: 'bundle', why: 'bundle' },
  { title: 'Pack ahorro cocina completo', expected: 'bundle', why: 'pack ahorro' },
  { title: 'Starter kit de fotografia', expected: 'bundle', why: 'starter kit' },

  // ── the NEAR MISSES: a substring match would get every one of these wrong ───
  { title: 'Mochila backpack impermeable', expected: 'base', why: 'backpack is not a pack' },
  { title: 'Cuadro sunset sobre lienzo', expected: 'base', why: 'sunset is not a set' },
  {
    title: 'Showcase de producto digital',
    expected: 'base',
    why: 'showcase is not a case',
  },
  {
    title: 'Apple iPhone 15 Pro',
    expected: 'base',
    why: 'the base product itself, once more, after every marker above',
  },
];

describe('relation detection', () => {
  it.each(CASES)('$title → $expected ($why)', ({ title, expected }) => {
    expect(detectRelation({ title }).relation).toBe(expected);
  });

  it('reads a stated multiple and refuses to invent one', () => {
    expect(detectPackCount(relationTokens('pack de 6'))).toBe(6);
    expect(detectPackCount(relationTokens('pack of 12'))).toBe(12);
    expect(detectPackCount(relationTokens('4 unidades'))).toBe(4);
    expect(detectPackCount(relationTokens('x3'))).toBe(3);
    expect(detectPackCount(relationTokens('3x'))).toBe(3);
    // A bare number is NOT a pack count, or "iPhone 15" would be a 15-pack.
    expect(detectPackCount(relationTokens('iPhone 15 Pro'))).toBeNull();
    // Neither is a count of one: a single item is not a multiple of itself.
    expect(detectPackCount(relationTokens('pack de 1'))).toBeNull();
  });

  it('lets a DECLARED pack-count axis beat anything read out of prose', () => {
    // The axis says six; the title says nothing. The structured fact wins.
    const declared = detectRelation({ title: 'Bombilla LED E27 9W', declaredPackCount: 6 });
    expect(declared.relation).toBe('multipack');
    expect(declared.packCount).toBe(6);

    // A declared ONE is not a multipack, whatever the marketing says.
    expect(detectRelation({ title: 'Bombilla LED E27 9W', declaredPackCount: 1 }).relation).toBe(
      'base',
    );
  });

  it('classifies a variant with COMPONENT rows as a bundle, whatever it is called', () => {
    const result = detectRelation({ title: 'Pack Consola', hasBundleComponents: true });
    expect(result.relation).toBe('bundle');
    expect(result.markers).toEqual(['bundle_components']);
  });

  it('folds accents, so `batería` and `bateria` classify the same', () => {
    expect(detectRelation({ title: 'Batería de repuesto' }).relation).toBe('replacement_part');
    expect(detectRelation({ title: 'Bateria de repuesto' }).relation).toBe('replacement_part');
  });

  it('names the marker that fired, so a refusal is explainable', () => {
    expect(detectRelation({ title: 'Funda para iPhone' }).markers).toEqual(['funda']);
    expect(detectRelation({ title: 'pack de 6 bombillas' }).markers).toContain('pack_count:6');
  });

  describe('sharing `wordTokens` (#830 de-duplication)', () => {
    // `relationTokens` used to carry its own copy of the `[^\p{L}\p{N}]` split
    // that #830 fixed in three other files. Adopting the shared tokenizer here
    // is a de-duplication and NOT part of that fix: every marker in this module
    // is Latin, and these pin that the adoption changed nothing for them.
    it('tokenizes Latin marker text exactly as before', () => {
      expect(relationTokens('pack ahorro de 6 bolsas')).toEqual([
        'pack',
        'ahorro',
        'de',
        '6',
        'bolsas',
      ]);
      expect(relationTokens('Bundle: cargador + cable USB-C')).toEqual([
        'bundle',
        'cargador',
        'cable',
        'usb',
        'c',
      ]);
      // An alphanumeric run stays whole — a model number is the most
      // discriminating token a title has.
      expect(relationTokens('Galaxy A2848')).toEqual(['galaxy', 'a2848']);
      // The accent fold still folds.
      expect(relationTokens('Batería plástico')).toEqual(['bateria', 'plastico']);
    });

    it('no longer fragments a non-Latin title — the control that it DID change', () => {
      // Without this the test above could pass against an unchanged tokenizer,
      // and would then be measuring nothing.
      expect(relationTokens('साइकिल')).toEqual(['साइकिल']);
      expect(relationTokens('ジャンク')).toEqual(['ジャンク']);
      expect(relationTokens('красный')).toEqual(['красный']);
    });

    it('still detects a Latin marker inside a non-Latin title', () => {
      // The reason the adoption is safe rather than merely inert: the markers
      // are Latin, so they are unaffected by how the surrounding script splits.
      expect(detectRelation({ title: 'साइकिल pack de 6' }).markers).toContain('pack_count:6');
    });
  });
});
