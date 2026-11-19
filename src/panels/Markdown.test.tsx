import { render } from '@testing-library/react';
import Markdown from './Markdown';

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
