import { describe, it, expect } from 'vitest';
// util.js must load first so the agent IIFE can read NH.config at evaluation time.
import '../lib/util.js';
import agent from '../lib/agent.js';

const { extractClaims, dedupeChunks, prepareChunks } = agent;

describe('extractClaims', () => {
    it('extracts a sentence and its single citation', () => {
        const claims = extractClaims('The sky is blue [1].');
        expect(claims).toEqual([{ claim: 'The sky is blue', chunk_nums: [1] }]);
    });

    it('parses multi-number citations like [1,3]', () => {
        const claims = extractClaims('Water boils at 100C [1, 3].');
        expect(claims).toHaveLength(1);
        expect(claims[0].chunk_nums).toEqual([1, 3]);
    });

    it('splits multiple cited sentences', () => {
        const claims = extractClaims('First fact [1]. Second fact [2].');
        expect(claims.map((c) => c.chunk_nums)).toEqual([[1], [2]]);
    });

    it('ignores sentences without citations', () => {
        const claims = extractClaims('This has no citation. But this does [2].');
        expect(claims).toHaveLength(1);
        expect(claims[0].claim).toBe('But this does');
    });

    it('returns nothing for an uncited answer', () => {
        expect(extractClaims('Just a plain disclaimer with no tags.')).toEqual([]);
    });
});

describe('dedupeChunks', () => {
    it('removes duplicates by id', () => {
        const out = dedupeChunks([
            { id: 'a', text: '1' },
            { id: 'a', text: '1 dup' },
            { id: 'b', text: '2' },
        ]);
        expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('falls back to doc_id:chunk_idx when id is absent', () => {
        const out = dedupeChunks([
            { doc_id: 'd', chunk_idx: 0 },
            { doc_id: 'd', chunk_idx: 0 },
            { doc_id: 'd', chunk_idx: 1 },
        ]);
        expect(out).toHaveLength(2);
    });
});

describe('prepareChunks', () => {
    it('orders external chunks first, then internal by ascending distance', () => {
        const out = prepareChunks([
            { id: '1', source: 'internal', distance: 0.9 },
            { id: '2', source: 'external', distance: 0.5 },
            { id: '3', source: 'internal', distance: 0.1 },
        ]);
        expect(out.map((c) => c.id)).toEqual(['2', '3', '1']);
    });

    it('caps the result at MAX_CONTEXT_CHUNKS (12)', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            id: String(i),
            source: 'internal',
            distance: i / 100,
        }));
        expect(prepareChunks(many)).toHaveLength(12);
    });
});
