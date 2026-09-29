import { describe, expect, it } from 'vitest';
import { MAX_ANSWER, parseTrainingImport } from '../src/ai/training/parseImport';

describe('parseTrainingImport', () => {
  it('reads question/answer pairs', () => {
    const result = parseTrainingImport([
      { question: 'Do you ship abroad?', answer: 'Yes, to 40 countries.' },
      { question: 'Opening hours?', answer: '9 to 6.' },
    ]);
    expect(result.format).toBe('pairs');
    expect(result.pairs).toEqual([
      { question: 'Do you ship abroad?', answer: 'Yes, to 40 countries.' },
      { question: 'Opening hours?', answer: '9 to 6.' },
    ]);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts key aliases and wrapper objects', () => {
    const result = parseTrainingImport({
      examples: [
        { message: 'Hi, price of the blue mug?', reply: '$12' },
        { q: 'Refunds?', a: 'Within 30 days.' },
        { input: 'Gift wrap?', output: 'Yes, free.' },
        { prompt: 'Warranty?', completion: 'Two years.' },
        { Question: 'Case-insensitive keys?', Answer: 'Yes.' },
      ],
    });
    expect(result.pairs.map((p) => p.answer)).toEqual(['$12', 'Within 30 days.', 'Yes, free.', 'Two years.', 'Yes.']);
  });

  it('extracts customer → agent exchanges from transcripts, merging consecutive turns', () => {
    const result = parseTrainingImport([
      {
        messages: [
          { role: 'agent', content: 'Welcome!' },
          { role: 'customer', content: 'Hello' },
          { role: 'customer', content: 'Can I change my order?' },
          { role: 'agent', content: 'Sure.' },
          { role: 'agent', content: 'Send me the order number.' },
          { role: 'customer', content: 'Thanks, bye' },
        ],
      },
    ]);
    expect(result.format).toBe('transcripts');
    expect(result.pairs).toEqual([
      { question: 'Hello\nCan I change my order?', answer: 'Sure.\nSend me the order number.' },
    ]);
  });

  it('accepts a single bare transcript', () => {
    const result = parseTrainingImport([
      { role: 'user', content: 'Is it vegan?' },
      { role: 'assistant', content: 'Yes, 100% plant based.' },
    ]);
    expect(result.pairs).toEqual([{ question: 'Is it vegan?', answer: 'Yes, 100% plant based.' }]);
  });

  it('keeps the last answer for a repeated question', () => {
    const result = parseTrainingImport([
      { question: 'Shipping cost?', answer: '$10' },
      { question: 'shipping cost?', answer: '$12' },
    ]);
    expect(result.pairs).toEqual([{ question: 'shipping cost?', answer: '$12' }]);
    expect(result.skipped).toBe(1);
  });

  it('reports unusable items without failing the file', () => {
    const result = parseTrainingImport([{ foo: 'bar' }, 42, { question: 'Q', answer: '' }, { question: 'Ok?', answer: 'Ok.' }]);
    expect(result.pairs).toHaveLength(1);
    expect(result.skipped).toBe(3);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects documents that are not lists', () => {
    const result = parseTrainingImport({ hello: 'world' });
    expect(result.pairs).toHaveLength(0);
    expect(result.errors[0].index).toBe(-1);
  });

  it('caps field length', () => {
    const result = parseTrainingImport([{ question: 'Long?', answer: 'x'.repeat(MAX_ANSWER + 500) }]);
    expect(result.pairs[0].answer).toHaveLength(MAX_ANSWER);
  });
});
