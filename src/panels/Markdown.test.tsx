import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import Markdown, { docPath } from './Markdown';

test('renders the markdown an agent replies with', () => {
  const text = [
    '## Summary',
    '',
    'Added **the toggle** and `theme.ts`; see [docs](https://example.com).',
    '',
    '- one',
    '- two',
    '  - nested',
    '',
    '1. first',
    '2. second',
    '',
    '```ts',
    'const a = 1 < 2;',
    '```',
    '',
    '| File | Lines |',
    '| --- | --- |',
    '| a.ts | 3 |',
  ].join('\n');
  const { container } = render(<Markdown text={text} />);
  expect(container.querySelector('h4')?.textContent).toBe('Summary');
  expect(container.querySelector('strong')?.textContent).toBe('the toggle');
  expect(container.querySelector('p code')?.textContent).toBe('theme.ts');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  expect(container.querySelectorAll('ul > li')).toHaveLength(3);
  expect(container.querySelector('ul ul li')?.textContent).toBe('nested');
  expect(container.querySelectorAll('ol > li')).toHaveLength(2);
  expect(container.querySelector('pre')?.textContent).toBe('const a = 1 < 2;');
  expect(container.querySelector('td')?.textContent).toBe('a.ts');
});

test('never injects markup from the text', () => {
  const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> [x](javascript:alert(1))'} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a')).toBeNull();
});

test('a markdown path is a doc path, with or without a line cited', () => {
  expect(docPath('docs/plan.md')).toBe('docs/plan.md');
  expect(docPath('~/.claude/plans/quiet-fox.md')).toBe('~/.claude/plans/quiet-fox.md');
  expect(docPath('/Users/me/app/PLAN.MD:12')).toBe('/Users/me/app/PLAN.MD');
  expect(docPath('./notes/a_b-c.markdown')).toBe('./notes/a_b-c.markdown');
  expect(docPath('src/main.rs')).toBeNull();
  expect(docPath('npm run docs.md --watch')).toBeNull();
  expect(docPath('.md')).toBeNull();
});

test('with a doc opener, markdown paths in code, links and text open the doc', () => {
  const opened: string[] = [];
  const text = 'Plan in `docs/plan.md:3`, spec at [spec](docs/spec.md), notes in notes/todo.md. Site: https://x.dev/a.md';
  const { container, getByText } = render(<Markdown text={text} onDoc={(p) => opened.push(p)} />);
  fireEvent.click(getByText('docs/plan.md:3'));
  fireEvent.click(getByText('spec'));
  fireEvent.click(getByText('notes/todo.md'));
  expect(opened).toEqual(['docs/plan.md', 'docs/spec.md', 'notes/todo.md']);
  // a web address stays a web link
  expect(container.querySelector('a[href="https://x.dev/a.md"]')).not.toBeNull();
});

test('without a doc opener, paths stay plain text', () => {
  const { container } = render(<Markdown text={'See `docs/plan.md` and notes/todo.md.'} />);
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).toBe('See docs/plan.md and notes/todo.md.');
});
