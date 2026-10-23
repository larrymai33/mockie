import type { Problem } from './contracts.js';

export const builtInProblems: Problem[] = [
  {
    id: 'two-sum', title: 'Two sum', difficulty: 'easy',
    description: 'Given an array of integers nums and an integer target, return the indices of the two distinct elements whose sum equals target. Exactly one pair exists. You may return the indices in either order.',
    examples: [
      { input: 'nums = [2, 7, 11, 15], target = 9', output: '[0, 1]', explanation: 'The elements at indices 0 and 1 add up to 9.' },
      { input: 'nums = [3, 3], target = 6', output: '[0, 1]' },
    ],
    constraints: ['There are between two and 10,000 elements.', 'Elements and target are integers.', 'Use two distinct indices; exactly one valid pair exists.'],
    starterCode: {
      python: 'def two_sum(nums, target):\n    # Return the two indices.\n    pass\n\nprint(two_sum([2, 7, 11, 15], 9))\n',
      javascript: 'function twoSum(nums, target) {\n  // Return the two indices.\n}\n\nconsole.log(twoSum([2, 7, 11, 15], 9));\n',
    },
  },
  {
    id: 'valid-parentheses', title: 'Valid parentheses', difficulty: 'easy',
    description: 'Given a string containing only parentheses, square brackets, and curly braces, determine whether every opening bracket is closed by the same bracket type in the correct order. An empty string is valid.',
    examples: [
      { input: 's = "([])"', output: 'true' },
      { input: 's = "([)]"', output: 'false' },
    ],
    constraints: ['The string contains at most 10,000 characters.', 'Only the characters ()[]{} occur.', 'The empty string is valid.'],
    starterCode: {
      python: 'def is_valid(s):\n    # Return True or False.\n    pass\n\nprint(is_valid("([])"))\n',
      javascript: 'function isValid(s) {\n  // Return true or false.\n}\n\nconsole.log(isValid("([])"));\n',
    },
  },
  {
    id: 'merge-intervals', title: 'Merge intervals', difficulty: 'medium',
    description: 'Given an array of closed intervals [start, end], merge all overlapping intervals and return the resulting intervals in ascending order of start. Intervals that share an endpoint overlap. The input may be unsorted.',
    examples: [
      { input: 'intervals = [[1, 3], [2, 6], [8, 10], [15, 18]]', output: '[[1, 6], [8, 10], [15, 18]]' },
      { input: 'intervals = [[1, 4], [4, 5]]', output: '[[1, 5]]' },
    ],
    constraints: ['There are at most 10,000 intervals.', 'Each interval has start <= end.', 'An empty input returns an empty array.'],
    starterCode: {
      python: 'def merge_intervals(intervals):\n    # Return the merged intervals.\n    pass\n\nprint(merge_intervals([[1, 3], [2, 6], [8, 10]]))\n',
      javascript: 'function mergeIntervals(intervals) {\n  // Return the merged intervals.\n}\n\nconsole.log(mergeIntervals([[1, 3], [2, 6], [8, 10]]));\n',
    },
  },
];

export function getProblem(id: string): Problem | undefined {
  return builtInProblems.find(problem => problem.id === id);
}
