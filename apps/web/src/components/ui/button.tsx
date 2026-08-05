import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white shadow-glow hover:bg-brand/90',
        secondary: 'border border-border bg-panel-raised text-text hover:bg-panel',
        ghost: 'text-muted hover:bg-panel-raised hover:text-text',
        danger: 'bg-negative text-white hover:bg-negative/90',
      },
      size: { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4', lg: 'h-11 px-5' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps): JSX.Element {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
