import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '../api/types';
import { answerKeys, isAnswered } from './askKeys';

const opts = (...labels: string[]) => labels.map((label) => ({ label, description: null }));
const fruit: AskQuestion = { question: 'Pick a fruit', header: 'Fruit', options: opts('Apple', 'Banana', 'Cherry'), multiSelect: false };
const colors: AskQuestion = { question: 'Pick colors', header: 'Colors', options: opts('Red', 'Green', 'Blue'), multiSelect: true };
const D = '\x1b[B';

// Sequences below were checked against Claude Code 2.1.328's picker in a real pty.
describe('answerKeys', () => {
  it('one single-select question: just the digit, no review screen', () => {
    expect(answerKeys([fruit], [{ picked: [1], text: '' }])).toEqual(['2']);
  });

  it('typed words take the "Type something" row, then Enter', () => {
    expect(answerKeys([fruit], [{ picked: [], text: 'kiwi\n42 ' }])).toEqual(['4', 'kiwi 42', '\r']);
  });

  it('two questions with a multi-select: toggles, Down to Next, Enter, then Submit answers', () => {
    expect(answerKeys([colors, fruit], [{ picked: [1], text: 'teal 7' }, { picked: [2], text: '' }]))
      .toEqual(['2', D, D, D, 'teal 7', D, '\r', '3', '1']);
  });

  it('a lone multi-select without words walks past the text row to Submit', () => {
    expect(answerKeys([colors], [{ picked: [2, 0], text: '' }])).toEqual(['1', '3', D, D, D, D, '\r', '1']);
  });

  it('two single-selects end on the review screen', () => {
    expect(answerKeys([fruit, fruit], [{ picked: [0], text: '' }, { picked: [], text: 'fig' }])).toEqual(['1', '4', 'fig', '\r', '1']);
  });
});

describe('answerKeys for Codex', () => {
  // checked against codex-cli 0.166.0's request_user_input menu in a real pty
  const fruit3: AskQuestion = { question: 'Favourite fruit?', header: null, options: opts('Apple', 'Pear', 'Plum'), multiSelect: false };
  const animal: AskQuestion = { question: 'Favourite animal?', header: null, options: opts('Cat', 'Dog'), multiSelect: false };

  it('a digit per question, no review screen', () => {
    expect(answerKeys([fruit3, animal], [{ picked: [2], text: '' }, { picked: [1], text: '' }], 'codex')).toEqual(['3', '2']);
  });

  it('typed words go in as a note on "None of the above"', () => {
    expect(answerKeys([fruit3, animal], [{ picked: [], text: 'kiwi 42' }, { picked: [1], text: '' }], 'codex'))
      .toEqual([D, D, D, '\t', 'kiwi 42', '\r', '2']);
  });
});

describe('isAnswered', () => {
  it('needs an option or words', () => {
    expect(isAnswered(fruit, undefined)).toBe(false);
    expect(isAnswered(fruit, { picked: [], text: '  ' })).toBe(false);
    expect(isAnswered(fruit, { picked: [0], text: '' })).toBe(true);
    expect(isAnswered(colors, { picked: [], text: 'teal' })).toBe(true);
    expect(isAnswered(colors, { picked: [0, 2], text: '' })).toBe(true);
  });
});
