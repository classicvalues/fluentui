import * as React from 'react';
import {
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
  Accordion,
  AccordionHeaderSize,
  AccordionHeaderExpandIconPosition,
} from './index';
import { RocketIcon } from './icons.stories';
import { AccordionToggleData, AccordionToggleEvent } from './components/Accordion/Accordion.types';

interface AccordionItemExampleProps {
  icon: boolean;
  inline: boolean;
  disabled: boolean;
  size: AccordionHeaderSize;
  expandIconPosition: AccordionHeaderExpandIconPosition;
  onToggle(ev: AccordionToggleEvent, data: AccordionToggleData): void;
  label: string;
}

export const AccordionItemExample = (args: AccordionItemExampleProps) => {
  return (
    <Accordion onToggle={args.onToggle} collapsible>
      <AccordionItem value="1" disabled={args.disabled}>
        <AccordionHeader
          inline={args.inline}
          icon={args.icon ? <RocketIcon /> : undefined}
          expandIconPosition={args.expandIconPosition}
          size={args.size}
        >
          {args.label}
        </AccordionHeader>
        <AccordionPanel>Accordion Panel</AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};
AccordionItemExample.argTypes = {
  onToggle: { action: 'toggled' },
  as: {
    control: false,
  },
  inline: {
    defaultValue: false,
    control: 'boolean',
  },
  label: {
    defaultValue: 'Accordion Header',
    type: 'string',
  },
  size: {
    defaultValue: 'medium',
    control: {
      type: 'select',
      options: ['small', 'medium', 'large', 'extra-large'],
    },
  },
  icon: {
    defaultValue: false,
    control: 'boolean',
  },
  expandIconPosition: {
    defaultValue: 'start',
    control: {
      type: 'inline-radio',
      options: ['start', 'end'],
    },
  },
};

export default {
  title: 'Components/AccordionItem',
  component: AccordionItem,
};
