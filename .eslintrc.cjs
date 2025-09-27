/**
 * Minimal ESLint config to forbid direct property assignments on ctx.vars
 * Use ctx.vars.set/get instead.
 */
module.exports = {
  root: true,
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      rules: {
        // Disallow: ctx.vars.foo = bar
        // Allow: ctx.vars.set('foo', bar)
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.property.name='vars']",
            message: 'Do not assign to ctx.vars.*; use ctx.vars.set()/merge()/update() instead.'
          }
        ]
      }
    }
  ]
};


