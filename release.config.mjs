/* eslint-env node */

/**
 * Custom commit template that includes the commit body in release notes.
 * Based on the default Angular preset template but enhanced to show body content.
 *
 * The template uses Handlebars syntax with some special conventions:
 * - {{~...}} trims whitespace before the expression
 * - {{...~}} trims whitespace after the expression
 * - {{!-- comment --}} is a comment
 *
 * The body is indented with 2 spaces so that list items (-) in the body
 * render as nested lists under the main commit bullet point.
 */
const commitPartial = `* {{#if scope}}**{{scope}}:** {{/if}}{{#if subject}}{{subject}}{{else}}{{header}}{{/if}} {{#if @root.linkReferences}}([{{shortHash}}]({{commitUrlFormat}})){{else}}({{shortHash}}){{/if}}{{#if references}}, closes{{#each references}} {{#if @root.linkReferences}}[{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}#{{this.issue}}]({{issueUrlFormat}}){{else}}{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}#{{this.issue}}{{/if}}{{/each}}{{/if}}
{{#if body}}

{{body}}

{{/if}}
`;

/**
 * Indent each line of the commit body with 2 spaces so that:
 * - Plain text appears as indented paragraphs
 * - Lines starting with `-` become nested list items under the main commit bullet
 *
 * @param {string} body - The commit body
 * @returns {string} - The indented body
 */
function indentBody(body) {
  if (!body) return body;
  return body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * finalizeContext runs after the default transform has filtered commits.
 * This allows us to modify only the commits that will appear in release notes
 * (feat, fix, perf, revert) without affecting the filtering logic.
 *
 * We iterate through each commit group and indent the body of each commit.
 */
function finalizeContext(context) {
  // Process each commit group (Features, Bug Fixes, etc.)
  if (context.commitGroups) {
    context.commitGroups = context.commitGroups.map((group) => ({
      ...group,
      commits: group.commits.map((commit) => ({
        ...commit,
        body: indentBody(commit.body),
      })),
    }));
  }
  return context;
}

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main', { name: 'beta', prerelease: true }],
  repositoryUrl: 'git+https://github.com/cosmocoder/mcp-web-docs.git',
  tagFormat: 'v${version}',

  plugins: [
    '@semantic-release/commit-analyzer',
    [
      '@semantic-release/release-notes-generator',
      {
        writerOpts: {
          commitPartial,
          finalizeContext,
        },
      },
    ],
    [
      '@semantic-release/npm',
      {
        provenance: true,
      },
    ],
    '@semantic-release/github',
  ],
};
