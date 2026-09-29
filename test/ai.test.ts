import { describe, expect, it } from 'vitest';
import { normalizeQuestion, questionHash } from '../src/ai/training/normalize';
import { withContext } from '../src/ai/types';
import { parseAssistantJson } from '../src/ai/providers/anthropic.provider';
import { mockAIProvider } from '../src/ai/providers/mock.provider';
import { formatKnowledgeContext } from '../src/ai/rag/retrieval';

describe('question normalization', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normalizeQuestion('  Do you   DELIVER?! ')).toBe('do you deliver');
    expect(questionHash('Do you deliver?')).toBe(questionHash('do you deliver'));
    expect(questionHash('Do you deliver?')).not.toBe(questionHash('Do you deliver abroad?'));
  });

  it('keeps non-Latin text', () => {
    expect(normalizeQuestion('আপনারা কি ডেলিভারি দেন?')).toBe('আপনারা কি ডেলিভারি দেন');
  });
});

describe('withContext', () => {
  it('folds context into the last user turn only', () => {
    const turns = withContext(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'price?' },
      ],
      'KNOWLEDGE',
    );
    expect(turns[0].content).toBe('hi');
    expect(turns[2].content).toBe('KNOWLEDGE\n\nCUSTOMER MESSAGE\nprice?');
  });
});

describe('parseAssistantJson', () => {
  it('reads structured replies', () => {
    expect(parseAssistantJson('{"answer":"Yes","confidence":0.9,"can_answer":true}')).toEqual({
      answer: 'Yes',
      confidence: 0.9,
      unanswered: false,
    });
  });

  it('treats an empty answer as unanswered', () => {
    expect(parseAssistantJson('{"answer":"","confidence":0.1,"can_answer":false}').unanswered).toBe(true);
  });
});

describe('offline assistant', () => {
  it('prefers an approved answer that matches the question', async () => {
    const context = formatKnowledgeContext(
      [{ id: 'c1', documentId: 'd1', documentTitle: 'Shipping', content: 'We ship with DHL to every EU country within 5 days.', score: 0.4 }],
      [{ id: 't1', question: 'Do you ship internationally?', answer: 'Yes! To over 40 countries.', score: 0.8 }],
    );
    const result = await mockAIProvider.generateResponse(
      [{ role: 'user', content: 'do you ship internationally' }],
      { model: 'mock', context },
    );
    expect(result.text).toBe('Yes! To over 40 countries.');
    expect(result.unanswered).toBe(false);
  });

  it('falls back to knowledge passages without the passage heading', async () => {
    const context = formatKnowledgeContext([
      { id: 'c1', documentId: 'd1', documentTitle: 'Returns', content: 'Returns are accepted within 30 days of delivery with a receipt.', score: 0.5 },
    ]);
    const result = await mockAIProvider.generateResponse(
      [{ role: 'user', content: 'Are returns accepted after delivery?' }],
      { model: 'mock', context },
    );
    expect(result.text).toBe('Returns are accepted within 30 days of delivery with a receipt.');
  });

  it('matches approved answers written in Bangla', async () => {
    const context = formatKnowledgeContext(
      [],
      [{ id: 't1', question: 'আপনারা কি ঢাকার বাইরে ডেলিভারি দেন?', answer: 'হ্যাঁ, সারা দেশে ৩-৫ দিনে।', score: 0.8 }],
    );
    const result = await mockAIProvider.generateResponse(
      [{ role: 'user', content: 'ঢাকার বাইরে ডেলিভারি দেন?' }],
      { model: 'mock', context },
    );
    expect(result.text).toBe('হ্যাঁ, সারা দেশে ৩-৫ দিনে।');
  });

  it('reports low confidence when nothing covers the question', async () => {
    const result = await mockAIProvider.generateResponse(
      [{ role: 'user', content: 'Can you fix my car engine?' }],
      { model: 'mock', context: formatKnowledgeContext([]) },
    );
    expect(result.unanswered).toBe(true);
  });
});
