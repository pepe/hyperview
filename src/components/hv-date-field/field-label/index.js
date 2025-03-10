// @flow

/**
 * Copyright (c) Garuda Labs, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type { Props } from './types';
import React from 'react';
import type { StyleSheet } from 'hyperview/src/types';
import { Text } from 'react-native';

/**
 * This text label of the field. Contains logic to decide how to format the value
 * or show the placeholder, including applying the right styles.
 */
export default (props: Props) => {
  const labelStyles: Array<StyleSheet> = [props.style];
  if (!props.value && props.placeholderTextColor) {
    labelStyles.push({ color: props.placeholderTextColor });
  }

  const label: string = props.value
    ? props.formatter(props.value, props.labelFormat)
    : props.placeholder || '';

  return <Text style={labelStyles}>{label}</Text>;
};
