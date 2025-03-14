import { useConst } from '@fluentui/react-utilities';
import * as React from 'react';

import { FluentProviderContextValues, FluentProviderState } from './FluentProvider.types';

export function useFluentProviderContextValues(state: FluentProviderState): FluentProviderContextValues {
  const { className, dir, targetDocument, theme } = state;

  const provider = React.useMemo(() => ({ dir, targetDocument }), [dir, targetDocument]);
  // "Tooltip" component mutates an object in this context, instance should be stable
  const tooltip = useConst({});

  return {
    provider,
    tooltip,
    theme,
    themeClassname: className,
  };
}
