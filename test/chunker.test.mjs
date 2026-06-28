import { describe, it, expect } from 'vitest';
import chunker from '../lib/chunker.js';

const { splitText, CHUNK_SIZE, SEPARATORS } = chunker;

describe('splitText (recursive character splitter)', () => {
    it('returns a single chunk for short text', () => {
        const out = splitText('a short sentence.', SEPARATORS);
        expect(out).toEqual(['a short sentence.']);
    });

    it('returns no chunks for empty text', () => {
        expect(splitText('', SEPARATORS)).toEqual([]);
    });

    it('keeps every chunk within the size limit for natural prose', () => {
        const para = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
        const out = splitText(para, SEPARATORS);
        expect(out.length).toBeGreaterThan(1);
        for (const c of out) expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
    });

    it('preserves content (no characters silently dropped)', () => {
        const para = Array.from({ length: 200 }, (_, i) => `tok${i}`).join(' ');
        const out = splitText(para, SEPARATORS);
        // Every original token should appear somewhere in the output.
        const joined = out.join(' ');
        for (let i = 0; i < 200; i++) expect(joined).toContain(`tok${i}`);
    });

    it('splits an oversized single token down to characters as a last resort', () => {
        const giant = 'x'.repeat(CHUNK_SIZE * 2 + 50);
        const out = splitText(giant, SEPARATORS);
        expect(out.length).toBeGreaterThan(1);
        expect(out.join('')).toBe(giant);
    });

    it('carries overlap so total output exceeds input length when split', () => {
        const sentences = Array.from(
            { length: 80 },
            (_, i) => `Sentence number ${i} here.`
        ).join(' ');
        const out = splitText(sentences, SEPARATORS);
        expect(out.length).toBeGreaterThan(1);
        // Overlap duplicates content across the seam, so the concatenated
        // chunk text is longer than the original.
        const totalLen = out.reduce((n, c) => n + c.length, 0);
        expect(totalLen).toBeGreaterThan(sentences.length);
    });
});
