import { StorybookExtractor } from './storybook-extractor.js';
import { GitHubPagesExtractor } from './github-pages-extractor.js';
import { DefaultExtractor } from './default-extractor.js';

export { ContentExtractor, ExtractedContent } from './content-extractor-types.js';

export const contentExtractors = {
  storybook: new StorybookExtractor(),
  github: new GitHubPagesExtractor(),
  default: new DefaultExtractor()
} as const;
