/* eslint-env node */

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main', { name: 'beta', prerelease: true }],
  repositoryUrl: 'git+https://github.com/cosmocoder/mcp-web-docs.git',
  tagFormat: 'v${version}',

  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      {
        provenance: true,
      },
    ],
    '@semantic-release/github',
  ],
};
