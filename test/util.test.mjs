import { describe, it, expect } from 'vitest';
import util from '../lib/util.js';

const { stripFences, safeJson, cosineDistance } = util;

describe('stripFences', () => {
    it('removes ```json fences', () => {
        expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('removes bare ``` fences', () => {
        expect(stripFences('```\nhello\n```')).toBe('hello');
    });

    it('leaves unfenced text untouched', () => {
        expect(stripFences('  plain text  ')).toBe('plain text');
    });

    it('handles null/undefined safely', () => {
        expect(stripFences(null)).toBe('');
        expect(stripFences(undefined)).toBe('');
    });
});

describe('safeJson', () => {
    it('parses valid JSON, stripping fences first', () => {
        expect(safeJson('```json\n{"answer":"hi"}\n```')).toEqual({ answer: 'hi' });
    });

    it('parses arrays', () => {
        expect(safeJson('["a", "b"]')).toEqual(['a', 'b']);
    });

    it('returns the fallback on invalid JSON', () => {
        expect(safeJson('not json', null)).toBeNull();
        expect(safeJson('also not json', [])).toEqual([]);
    });
});

describe('cosineDistance', () => {
    it('is 0 for identical vectors', () => {
        expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 10);
    });

    it('is ~1 for orthogonal vectors', () => {
        expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
    });

    it('is ~2 for opposite vectors', () => {
        expect(cosineDistance([1, 1], [-1, -1])).toBeCloseTo(2, 10);
    });

    it('returns 1 when either vector is all zeros', () => {
        expect(cosineDistance([0, 0], [1, 1])).toBe(1);
        expect(cosineDistance([1, 1], [0, 0])).toBe(1);
    });

    it('compares only the overlapping dimensions when lengths differ', () => {
        // truncates to min length; [1,0] vs [1,0] -> identical -> 0
        expect(cosineDistance([1, 0, 99], [1, 0])).toBeCloseTo(0, 10);
    });
});
