/**
 * React 19 removed the global `JSX` namespace from `@types/react`.
 *
 * This codebase annotates component return types as `JSX.Element`, which used to
 * resolve globally. Rather than rewriting every annotation to `React.JSX.Element`
 * or dropping them (both churn with no behavioural gain), re-surface the namespace
 * globally through React's own exported types so the annotations keep meaning the
 * same thing they always did.
 */
import type { JSX as ReactJSX } from 'react';

declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementType = ReactJSX.ElementType;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
  }
}
