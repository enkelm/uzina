# Uzina web application

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The Factory Owner and participants who have access to projects and Work items. The user has explicitly requested a usable UI now, in parallel with unfinished transfer work.

## Product Purpose

Let a person find a Work item, read its conversation and status, send input, and choose an explicit existing Workspace when creating work. This is an application screen, not a marketing page.

## Operating Context

Uzina is one Factory per deployment. The Controller owns command authorization and lifecycle. Pi Durable schedules model work. Execution nodes supply assigned capabilities and Workspaces. The UI consumes the existing authorized HTTP API and typed FactoryClient. See the root SPEC.md and GLOSSARY.md for established product truth.

## Capabilities and Constraints

The first UI covers a Work item list, conversation, status and history, project creation and Work item creation with explicit existing node/Workspace selection. Show only behavior the current API provides. Command acceptance is not completion. Owner, Guest and Viewer controls must match actual API authorization.

The Owner also has a **Factory chat** entry in the header, separate from Work chats and project selection. It uses the existing private-assistant conversation for coordination, with current context, honest receipt states, same-tab uncertain-send recovery, and a read-only parked state. Guests and Viewers cannot open or read it. Native conversations remain in Rex; no board UI, transcript synchronization, or browser terminal is introduced.

Coherent Checkpoints, Workspace movement, inactive import and source holds exist in the backend, but end-to-end ownership transfer and local continuation are unfinished. Do not expose transfer, retirement, release or activation actions. No frontend implementation of authorization, model scheduling, filesystem restore, terminals or execution processes.

Use origin-bound human sessions via HttpOnly cookies, with pi-coop-style private sign-in links and single-use scoped invitations. Do not put bearer values in React state, Web Storage, application URLs, events, or rendered history; the native `/login` confirmation consumes the credential link and redirects to `/`. The local Factory prints the owner link to its private console. Sharing and revocation remain Core-authorized. Do not forward source/local Owner credentials to another Controller. Development UI and API proxy are loopback-only by default. This work does not deploy public ingress, add tenants, synchronize accounts or migrate the Factory database.

## Evidence on Hand

Existing typed client, contracts/Core HTTP routes, real Bun/Cloudflare tests and root specification. There is no existing visual UI to inherit. Any illustrative preview content must be explicitly labeled synthetic and must not be used as evidence of backend behavior. Real application states are the default.

## Product Principles

- Make actual Work items and their state easy to find.
- Use the application's domain terms and clear action labels.
- Distinguish accepted, pending, complete, failed and uncertain work.
- Preserve explicit execution placement and current authorization.
- Show truthful empty, unavailable, revoked and error states.

## Accessibility & Inclusion

The user has requested concise, clear language and ASD-STE100-oriented wording. Use semantic controls, visible keyboard focus, accessible labels, sufficient contrast and reduced-motion support. Keep long names, paths and messages readable on desktop and narrow screens.

## Implementation choices and open decisions

The app uses React 19, TypeScript, and TanStack Start with TanStack Router and Vite, following the user's dependency-migration request. Start runs in SPA mode so private Factory data remains client-side. ui-sdk is installed for future component work; existing controls retain their behavior and visual identity. Product facts and initial scope above come from the user request and existing specification. Visual direction is an implementation choice, not a user-approved brand. Prioritize a working first screen; no blocking brand interview or marketing claims. Full PWA/offline behavior, workforce assignment/delivery and production deployment remain outside this increment.
