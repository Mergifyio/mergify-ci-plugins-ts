import type { Attributes } from '@opentelemetry/api';

export function detect(playwrightVersion: string): Attributes {
  return {
    'test.framework': 'playwright',
    'test.framework.version': playwrightVersion,
  };
}
