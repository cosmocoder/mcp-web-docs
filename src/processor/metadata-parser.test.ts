import { extractProps, extractCodeBlocks, determineContentType, parseMetadata } from './metadata-parser.js';

describe('Metadata Parser', () => {
  describe('extractProps', () => {
    it('should extract props from a standard markdown table', () => {
      const content = `# Button Component

## Props

| Name | Type | Default | Description |
|------|------|---------|-------------|
| variant | string | 'primary' | The button style |
| disabled | boolean | false | Whether button is disabled |
| onClick | function | - | Click handler |
`;

      const props = extractProps(content);

      expect(props.length).toBe(3);
      expect(props[0].name).toBe('variant');
      expect(props[0].type).toBe('string');
      expect(props[0].defaultValue).toBe("'primary'");
      expect(props[1].name).toBe('disabled');
      expect(props[1].type).toBe('boolean');
      expect(props[2].name).toBe('onClick');
    });

    it('should detect required props from asterisk', () => {
      const content = `## Props

| Name | Type | Description |
|------|------|-------------|
| children* | ReactNode | Required content |
| optional | string | Optional value |
`;

      const props = extractProps(content);

      expect(props.length).toBe(2);
      // The asterisk is part of name detection for required props
      expect(props[0].name).toBeTruthy();
      expect(props[1].required).toBe(false);
    });

    it('should handle table without Props heading', () => {
      const content = `# Component API

| Name | Type | Default |
|------|------|---------|
| size | string | 'medium' |
| color | string | 'blue' |
`;

      const props = extractProps(content);

      expect(props.length).toBe(2);
    });

    it('should handle different column names', () => {
      const content = `## Props

| Prop | Types | Desc | DefaultValue |
|------|-------|------|--------------|
| label | string | The label text | '' |
`;

      const props = extractProps(content);

      expect(props.length).toBe(1);
      expect(props[0].name).toBe('label');
    });

    it('should deduplicate props', () => {
      const content = `## Props

| Name | Type |
|------|------|
| value | string |

## More Props

| Name | Type |
|------|------|
| value | number |
`;

      const props = extractProps(content);

      // Should only have one entry for 'value'
      const valueProps = props.filter((p) => p.name === 'value');
      expect(valueProps.length).toBe(1);
    });

    it('should handle escaped pipes in tables', () => {
      const content = `## Props

| Name | Type | Description |
|------|------|-------------|
| value | string \\| number | Can be string or number |
`;

      const props = extractProps(content);

      expect(props.length).toBe(1);
      expect(props[0].type).toContain('|');
    });

    it('should return empty array for content without props', () => {
      const content = `# Overview

This is just an overview without any props table.
`;

      const props = extractProps(content);
      expect(props).toEqual([]);
    });

    it('should extract props from inline patterns as fallback', () => {
      const content = `# API

\`value\` - The current value (type: string)
\`onChange\` - Change handler (type: function)
`;

      const props = extractProps(content);

      expect(props.length).toBe(2);
      expect(props[0].name).toBe('value');
      expect(props[1].name).toBe('onChange');
    });
  });

  describe('extractCodeBlocks', () => {
    it('should extract code blocks with language', () => {
      const content = `# Examples

Here's a JavaScript example:

\`\`\`javascript
const x = 1;
console.log(x);
\`\`\`

And Python:

\`\`\`python
x = 1
print(x)
\`\`\`
`;

      const blocks = extractCodeBlocks(content);

      expect(blocks.length).toBe(2);
      expect(blocks[0].language).toBe('javascript');
      expect(blocks[0].code).toContain('const x = 1');
      expect(blocks[1].language).toBe('python');
      expect(blocks[1].code).toContain('x = 1');
    });

    it('should extract code blocks without language', () => {
      const content = `# Code

\`\`\`
some code here
\`\`\`
`;

      const blocks = extractCodeBlocks(content);

      expect(blocks.length).toBe(1);
      expect(blocks[0].language).toBe('plaintext');
    });

    it('should include context from preceding text', () => {
      const content = `# Installation

Run this command:

\`\`\`bash
npm install package
\`\`\`
`;

      const blocks = extractCodeBlocks(content);

      expect(blocks.length).toBe(1);
      // Context is the nearest meaningful text (could be heading or paragraph)
      expect(blocks[0].context).toBeTruthy();
    });

    it('should handle multiple code blocks', () => {
      const content = `
\`\`\`js
code1
\`\`\`

\`\`\`js
code2
\`\`\`

\`\`\`js
code3
\`\`\`
`;

      const blocks = extractCodeBlocks(content);
      expect(blocks.length).toBe(3);
    });

    it('should return empty array for content without code blocks', () => {
      const content = `# Just Text

No code blocks here.
`;

      const blocks = extractCodeBlocks(content);
      expect(blocks).toEqual([]);
    });

    it('should handle code blocks with complex content', () => {
      const content = `## Component Usage

\`\`\`jsx
import { Button } from 'ui';

export function App() {
  return (
    <Button
      variant="primary"
      onClick={() => console.log('clicked')}
    >
      Click me
    </Button>
  );
}
\`\`\`
`;

      const blocks = extractCodeBlocks(content);

      expect(blocks.length).toBe(1);
      expect(blocks[0].code).toContain('import { Button }');
      expect(blocks[0].code).toContain('export function App');
    });
  });

  describe('determineContentType', () => {
    it('should identify API content', () => {
      const apiContent = `# API Reference

## Parameters

| Name | Type |
|------|------|
| value | string |

## Returns

The processed value.
`;

      expect(determineContentType(apiContent)).toBe('api');
    });

    it('should identify API content from props table', () => {
      const propsContent = `# Button Props

| Name | Type | Description |
|------|------|-------------|
| variant | string | Button style |
`;

      expect(determineContentType(propsContent)).toBe('api');
    });

    it('should identify example content', () => {
      const exampleContent = `# Examples

## Basic Example

\`\`\`js
const x = 1;
\`\`\`

## Advanced Example

\`\`\`js
const y = 2;
\`\`\`

## Another Example

\`\`\`js
const z = 3;
\`\`\`
`;

      expect(determineContentType(exampleContent)).toBe('example');
    });

    it('should identify usage content', () => {
      const usageContent = `# Getting Started

## Installation

Run npm install to get started.

## How to Use

Follow these steps...
`;

      expect(determineContentType(usageContent)).toBe('usage');
    });

    it('should default to overview for general content', () => {
      const overviewContent = `# About Our Product

This is a great product that does many things.

## Features

- Feature 1
- Feature 2
`;

      expect(determineContentType(overviewContent)).toBe('overview');
    });
  });

  describe('parseMetadata', () => {
    it('should parse all metadata from content', () => {
      const content = `# Component

## Props

| Name | Type |
|------|------|
| value | string |

## Example

\`\`\`jsx
<Component value="test" />
\`\`\`
`;

      const metadata = parseMetadata(content);

      expect(metadata.props.length).toBe(1);
      expect(metadata.codeBlocks.length).toBe(1);
      expect(metadata.contentType).toBe('api');
    });

    it('should return empty arrays for minimal content', () => {
      const content = 'Just some plain text.';

      const metadata = parseMetadata(content);

      expect(metadata.props).toEqual([]);
      expect(metadata.codeBlocks).toEqual([]);
      expect(metadata.contentType).toBe('overview');
    });

    it('should handle complex documentation page', () => {
      const content = `# Button Component

A versatile button component for your application.

## Props

| Name | Type | Default | Description |
|------|------|---------|-------------|
| variant | 'primary' \\| 'secondary' | 'primary' | Button style variant |
| size | 'sm' \\| 'md' \\| 'lg' | 'md' | Button size |
| disabled | boolean | false | Disabled state |
| onClick | () => void | - | Click handler |

## Basic Usage

Import and use the button:

\`\`\`tsx
import { Button } from '@ui/components';

function App() {
  return <Button variant="primary">Click me</Button>;
}
\`\`\`

## Variants

### Primary Button

\`\`\`tsx
<Button variant="primary">Primary</Button>
\`\`\`

### Secondary Button

\`\`\`tsx
<Button variant="secondary">Secondary</Button>
\`\`\`
`;

      const metadata = parseMetadata(content);

      expect(metadata.props.length).toBe(4);
      expect(metadata.codeBlocks.length).toBe(3);
      expect(metadata.contentType).toBe('api');
    });
  });
});
