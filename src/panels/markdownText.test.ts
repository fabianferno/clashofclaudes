import { plainText } from './markdownText';
import { sessionName, taskTooltip } from './sessionName';

test('markdown reads as one line of plain text', () => {
  expect(plainText('## Fix the **login** bug\n\n- see `auth.ts`\n- [docs](https://x.y)\n\n```\nnpm test\n```')).toBe(
    'Fix the login bug see auth.ts docs npm test',
  );
  expect(plainText('keep snake_case_names and 2 * 3 * 4 as they are')).toBe('keep snake_case_names and 2 * 3 * 4 as they are');
  expect(plainText('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a · b 1 · 2');
});

test('a session named after its task drops the markdown', () => {
  expect(sessionName({ title: null, task: '# Add a **dark** mode' })).toBe('Add a dark mode');
  expect(sessionName({ title: 'Dark mode', task: '# x' })).toBe('Dark mode');
  expect(taskTooltip({ title: 'Dark mode', task: '- one\n- two' })).toBe('one two');
});
