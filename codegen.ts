import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './schema.json',
  documents: ['**/*.{ts,tsx}'], // looks for GraphQL operations in all TypeScript files
  generates: {
    './lib/gql/': {
      preset: 'client',
      plugins: [
        'typescript',
        'typescript-operations',
        'typescript-react-apollo'
      ],
      config: {
        withHooks: true,
        withHOC: false,
        withComponent: false,
        skipTypename: false,
        dedupeFragments: true,
        exportFragmentSpreadSubTypes: true,
        namingConvention: {
          typeNames: 'change-case-all#pascalCase',
          enumValues: 'change-case-all#upperCase'
        }
      }
    }
  }
};

export default config; 