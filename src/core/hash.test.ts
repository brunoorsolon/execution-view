import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from './hash.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('sorts keys by code unit, not locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, '10': 5, '9': 6 })).toBe(
      '{"10":5,"9":6,"B":2,"_":4,"a":3,"b":1}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: ['b', 'a'] })).toBe('{"a":["b","a"]}');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, { b: 'x y' }] })).toBe('{"a":[1,{"b":"x y"}]}');
  });

  it('drops undefined properties', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: { d: undefined } })).toBe('{"b":1,"c":{}}');
  });

  it('keeps null', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('is independent of key insertion order', () => {
    const a = { x: 1, y: { p: 1, q: 2 } };
    const b = { y: { q: 2, p: 1 }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('throws on NaN and Infinity, including nested', () => {
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson(-Infinity)).toThrow();
    expect(() => canonicalJson({ a: [1, { b: NaN }] })).toThrow();
  });
});

describe('contentHash', () => {
  it('matches a known sha256 for a fixed input', () => {
    // sha256 of the UTF-8 bytes of {"a":1,"b":[1,2]}
    expect(contentHash({ b: [1, 2], a: 1 })).toBe(
      '8baa73198470c7bb4c3ce142a8fd651affc0310d878bb9bd159e37a573fb4874',
    );
  });

  it('is a 64-char lowercase hex string', () => {
    expect(contentHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key order and repeated calls', () => {
    const h = contentHash({ a: 1, b: { c: 2, d: 3 } });
    expect(contentHash({ b: { d: 3, c: 2 }, a: 1 })).toBe(h);
    expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(h);
  });

  it('changes when content changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('propagates canonicalJson errors', () => {
    expect(() => contentHash({ a: NaN })).toThrow();
  });
});
