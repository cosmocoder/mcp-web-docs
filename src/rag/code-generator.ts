export interface CodeExample {
  imports: string;
  props: string;
  usage: string;
}

export class CodeGenerator {
  async generateCodeExample(component: any, context: any): Promise<CodeExample> {
    // Extract component name and props from the component info
    const componentName = component.name || 'Example';
    const componentProps = component.props || {};

    // Generate imports based on context
    const imports = this.generateImports(componentName, context);

    // Generate props string
    const props = this.generateProps(componentProps);

    // Generate usage example
    const usage = this.generateUsage(componentName, props);

    return { imports, props, usage };
  }

  private generateImports(componentName: string, context: any): string {
    // Look for import path in context
    const importPath = context.importPath || 'example';
    return `import ${componentName} from '${importPath}';`;
  }

  private generateProps(props: Record<string, any>): string {
    return Object.entries(props)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ');
  }

  private generateUsage(componentName: string, props: string): string {
    return props
      ? `<${componentName} ${props} />`
      : `<${componentName} />`;
  }
}
