# Coding Standards

## Single responsibility

Every file, module, component, function and service should have one clear purpose.

Split code when a file starts mixing multiple responsibilities such as:

- UI rendering
- database access
- external API calls
- validation
- financial calculations
- authorization

## TypeScript

- Keep strict mode enabled.
- Avoid `any`.
- Avoid unsafe type assertions.
- Validate untrusted external data before using it.
- Prefer explicit domain types.

## Naming

Use names that explain intent.

Avoid vague names such as:

- data
- item
- thing
- helper
- utils for unrelated functions
- handler2

## Functions

- Keep functions focused and reasonably small.
- Prefer explicit inputs and outputs.
- Avoid hidden global state.
- Avoid functions with unrelated side effects.

## Components

- Keep presentation separate from business logic.
- Prefer reusable components when reuse is real, not speculative.
- Do not over-engineer abstractions.

## Comments

Do not comment obvious syntax.

Add comments for:

- financial rules
- non-obvious calculations
- security-sensitive decisions
- provider quirks
- important reasons behind unusual implementation choices

## Configuration

Do not hardcode business configuration that should be editable or environment-specific.

## Dead code

Do not leave:

- commented-out implementations
- debug logging
- unused files
- abandoned experimental code

## Documentation rule

When architecture, setup, schema or integration behavior changes, update the relevant documentation in the same task.
