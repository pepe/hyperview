// @flow

/**
 * Copyright (c) Garuda Labs, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import { NAV_ACTIONS, NavAction } from 'hyperview/src/types';
import {
  cleanHrefFragment,
  getVirtualScreenId,
  isUrlFragment,
} from 'hyperview/src/navigator-helpers';
import { Navigation } from '@react-navigation/native';

/**
 * Perform logic for navigation actions based on the current navigation hierarchy
 */
export default class NavLogic {
  navigation: Navigation;

  constructor(navigation: Navigation) {
    if (!navigation) {
      throw new Error('NavLogic requires a navigation object');
    }
    this.navigation = navigation;
  }

  /**
   * Recursively search for the target in state and build a path to it
   */
  findPath = (state: Object, targetRouteId: string, path: string[]) => {
    const { routes } = state;
    if (routes) {
      for (let i = 0; i < routes.length; i += 1) {
        const route: Object = routes[i];
        if (route.name === targetRouteId) {
          path.push(route.name);
        } else if (route.state) {
          this.findPath(route.state, targetRouteId, path);
          if (path.length) {
            path.push(route.name);
          }
        }
        if (path.length) {
          break;
        }
      }
    }
  };

  /**
   * Continue up the hierarchy until a navigation is found which contains the target
   * If the target is not found, no navigation is returned
   */
  getNavigatorAndPath = (targetRouteId: string): [Navigation, string[]] => {
    let { navigation }: Navigation = this;
    if (!targetRouteId) {
      return [navigation, null];
    }
    while (navigation) {
      const path: string[] = [];
      this.findPath(navigation.getState(), targetRouteId, path);
      if (path.length) {
        return [navigation, path];
      }
      navigation = navigation.getParent();
    }
    return [null, null];
  };

  /**
   * Generate a nested param hierarchy with instructions for each screen to step through to the target
   */
  buildParams = (
    routeId: string,
    path: string[],
    routeParams: Object,
  ): Object => {
    const prms: Object = {};
    if (path.length) {
      prms.screen = path.pop();
      prms.params = this.buildParams(routeId, path, routeParams);
    } else {
      prms.screen = routeId;
      // The last screen in the path receives the route params
      prms.params = routeParams;
    }
    return prms;
  };

  /**
   * Build the request structure including finding the navigation, building params, and determining screen id
   */
  buildRequest = (
    action: NavAction,
    routeParams: Object,
  ): [Navigation, Object, string] => {
    const [navigation, path] = this.getNavigatorAndPath(routeParams.target);

    // Clean up the params to remove the target and url if they are not needed
    const cleanedParams: Object = { ...routeParams };
    delete cleanedParams.target;
    if (isUrlFragment(cleanedParams.url)) {
      delete cleanedParams.url;
    }

    let routeId = cleanHrefFragment(
      getVirtualScreenId(navigation, action, routeParams.url),
    );
    let params: Object;
    if (!path || !path.length) {
      params = cleanedParams;
    } else {
      // The last path id is the screen id, remove from the path to avoid adding it in params
      const lastPathId = path.pop();
      params = this.buildParams(routeId, path, cleanedParams);
      routeId = lastPathId;
    }

    return [navigation, routeId, params];
  };

  /**
   * Prepare and send the request
   */
  sendRequest = (action: NavAction, routeParams: Object) => {
    let { navigation } = this;
    let routeId: String = null;
    let requestParams: Object = null;
    if (routeParams) {
      const [requestNavigation, requestRouteId, params] = this.buildRequest(
        action,
        routeParams || {},
      );

      navigation = requestNavigation;
      routeId = requestRouteId;
      requestParams = params;
    }

    if (!navigation) {
      return;
    }
    switch (action) {
      case NAV_ACTIONS.BACK:
        navigation.goBack(requestParams);
        break;
      case NAV_ACTIONS.CLOSE:
        navigation.goBack(requestParams);
        break;
      case NAV_ACTIONS.NAVIGATE:
        navigation.navigate(routeId, requestParams);
        break;
      case NAV_ACTIONS.NEW:
        navigation.navigate(routeId, requestParams);
        break;
      case NAV_ACTIONS.PUSH:
        navigation.push(routeId, requestParams);
        break;
      default:
    }
  };

  back = routeParams => {
    this.sendRequest(NAV_ACTIONS.BACK, routeParams);
  };

  closeModal = routeParams => {
    this.sendRequest(NAV_ACTIONS.CLOSE, routeParams);
  };

  navigate = (routeParams, key) => {
    this.sendRequest(NAV_ACTIONS.NAVIGATE, routeParams);
  };

  openModal = routeParams => {
    this.sendRequest(NAV_ACTIONS.NEW, routeParams);
  };

  push = routeParams => {
    this.sendRequest(NAV_ACTIONS.PUSH, routeParams);
  };
}
