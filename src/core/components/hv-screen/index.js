/**
 * Copyright (c) Garuda Labs, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint instawork/flow-annotate: 0 */
import * as Behaviors from 'hyperview/src/behaviors';
import * as Components from 'hyperview/src/services/components';
import * as Contexts from 'hyperview/src/contexts';
import * as Dom from 'hyperview/src/services/dom';
import * as Events from 'hyperview/src/services/events';
import * as Namespaces from 'hyperview/src/services/namespaces';
import * as Render from 'hyperview/src/services/render';
import * as Stylesheets from 'hyperview/src/services/stylesheets';
import * as UrlService from 'hyperview/src/services/url';
import * as Xml from 'hyperview/src/services/xml';
import { ACTIONS, NAV_ACTIONS, UPDATE_ACTIONS } from 'hyperview/src/types';
// eslint-disable-next-line instawork/import-services
import Navigation, { ANCHOR_ID_SEPARATOR } from 'hyperview/src/services/navigation';
import { createProps, createStyleProp, getElementByTimeoutId, getFormData, later, removeTimeoutId, setTimeoutId, shallowCloneToRoot } from 'hyperview/src/services';
import { Linking } from 'react-native';
import LoadElementError from '../load-element-error';
import LoadError from 'hyperview/src/core/components/load-error';
import Loading from 'hyperview/src/core/components/loading';
import React from 'react';

// eslint-disable-next-line instawork/pure-components
export default class HvScreen extends React.Component {
  static createProps = createProps;

  static createStyleProp = createStyleProp;

  static renderChildren = Render.renderChildren;

  static renderElement = Render.renderElement;

  constructor(props) {
    super(props);

    this.onUpdate = this.onUpdate.bind(this);
    this.reload = this.reload.bind(this);

    this.updateActions = ['replace', 'replace-inner', 'append', 'prepend'];
    this.parser = new Dom.Parser(
      this.props.fetch,
      this.props.onParseBefore,
      this.props.onParseAfter
    );

    this.needsLoad = false;
    this.state = {
      doc: null,
      elementError: null,
      error: null,
      staleHeaderType: null,
      styles: null,
      url: null,
    };
    // Injecting a passed document as a single-use document
    this.initialDoc = props.doc;

    // <HACK>
    // In addition to storing the document on the react state, we keep a reference to it
    // on the instance. When performing batched updates on the DOM, we need to ensure every
    // update occurence operates on the latest DOM version. We cannot rely on `state` right after
    // setting it with `setState`, because React does not guarantee the new state to be immediately
    // available (see details here: https://reactjs.org/docs/react-component.html#setstate)
    // Whenever we need to access the document for reasons other than rendering, we should use
    // `this.doc`. When rendering, we should use `this.state.doc`.
    this.doc = null;
    this.oldSetState = this.setState;
    this.setState = (...args) => {
      if (args[0].doc !== undefined) {
        this.doc = args[0].doc;
      }
      this.oldSetState(...args);
    }
    // </HACK>

    this.behaviorRegistry = Behaviors.getRegistry(this.props.behaviors);
    this.componentRegistry = Components.getRegistry(this.props.components);
    this.formComponentRegistry = Components.getFormRegistry(this.props.components);
    this.navigation = new Navigation(props.entrypointUrl, this.getNavigation());
  }

  getRoute = (props) => {
    // The prop route is available in React Navigation v5 and above
    if (props.route) {
      return props.route
    }

    // Fallback for older versions of React Navigation
    if (props.navigation) {
      return props.navigation.state;
    }
    return { params: {} };
  }

  componentDidMount() {
    const { params } = this.getRoute(this.props);
    // The screen may be rendering via a navigation from another HyperScreen.
    // In this case, the url to load in the screen will be passed via navigation props.
    // Otherwise, use the entrypoint URL provided as a prop to the first HyperScreen.
    const url = params.url || this.props.entrypointUrl || null;

    const preloadScreen = params.preloadScreen
      ? this.navigation.getPreloadScreen(params.preloadScreen)
      : null;
    const preloadStyles = preloadScreen ? Stylesheets.createStylesheets(preloadScreen) : {};

    this.needsLoad = true;
    if (preloadScreen) {
      this.setState({
        doc: preloadScreen,
        elementError: null,
        error: null,
        styles: preloadStyles,
        url,
      });
    } else {
      this.setState({
        elementError: null,
        error: null,
        url,
      });
    }
  }

  /**
   * Potentially updates state when navigating back to the mounted screen.
   * If the navigation params have a different URL than the screen's URL, Update the
   * preload screen and URL to load.
   */
  // eslint-disable-next-line camelcase
  UNSAFE_componentWillReceiveProps = (nextProps) => {
    const oldNavigationState = this.getRoute(this.props);
    const newNavigationState = this.getRoute(nextProps);

    const newUrl = newNavigationState.params.url;
    const oldUrl = oldNavigationState.params.url;
    const newPreloadScreen = newNavigationState.params.preloadScreen;
    const oldPreloadScreen = oldNavigationState.params.preloadScreen;

    if (newPreloadScreen !== oldPreloadScreen) {
      this.navigation.removePreloadScreen(oldPreloadScreen);
    }

    // TODO: If the preload screen is changing, delete the old one from
    // this.navigation.preloadScreens to prevent memory leaks.

    if (newUrl && newUrl !== oldUrl) {
      this.needsLoad = true;

      const preloadScreen = newPreloadScreen
        ? this.navigation.getPreloadScreen(newPreloadScreen)
        : null;

      const doc = preloadScreen || this.doc;
      // eslint-disable-next-line react/no-access-state-in-setstate
      const styles = preloadScreen ? Stylesheets.createStylesheets(preloadScreen) : this.state.styles;

      this.setState({ doc, styles, url: newUrl });
    }
  }

  /**
   * Clear out the preload screen associated with this screen.
   */
  componentWillUnmount() {
    const { params } = this.getRoute(this.props);
    const { preloadScreen } = params;
    if (preloadScreen && this.navigation.getPreloadScreen(preloadScreen)) {
      this.navigation.removePreloadScreen(preloadScreen);
    }
    if (this.state.url) {
      this.navigation.removeRouteKey(this.state.url)
    }
  }

  /**
   * Fetch data from the url if the screen should reload.
   */
  componentDidUpdate() {
    if (this.needsLoad) {
      this.load(this.state.url);
      this.needsLoad = false;
    }
  }

  /**
   * Performs a full load of the screen.
   */
  load = async () => {
    const { params, key: routeKey } = this.getRoute(this.props);

    try {
      if (params.delay) {
        await later(parseInt(params.delay, 10));
      }

      // If an initial document was passed, use it once and then remove
      let doc;
      let staleHeaderType;
      if (this.initialDoc){
        doc = this.initialDoc;
        this.initialDoc = null;
      } else {
        // eslint-disable-next-line react/no-access-state-in-setstate
        const { doc : loadedDoc, staleHeaderType : loadedType } = await this.parser.loadDocument(this.state.url);
        doc = loadedDoc;
        staleHeaderType = loadedType;
      }
      const stylesheets = Stylesheets.createStylesheets(doc);
      this.navigation.setRouteKey(this.state.url, routeKey);
      this.setState({
        doc,
        elementError: null,
        error: null,
        staleHeaderType,
        styles: stylesheets,
      });

    } catch (err) {
      if (this.props.onError) {
        this.props.onError(err);
      }
      this.setState({
        doc: null,
        elementError: null,
        error: err,
        styles: null,
      });
    }
  }

  /**
   * Reload if an error occured.
   * @param opt_href: Optional string href to use when reloading the screen. If not provided,
   * the screen's current URL will be used.
   */
  reload = (optHref, opts) => {
    const isBlankHref =
      optHref === null ||
      optHref === undefined ||
      optHref === '#' ||
      optHref === '';
    const url = isBlankHref
      ? this.state.url // eslint-disable-line react/no-access-state-in-setstate
      : UrlService.getUrlFromHref(optHref, this.state.url); // eslint-disable-line react/no-access-state-in-setstate

    if (!url) {
      return;
    }

    const options = opts || {};
    const {
      behaviorElement, showIndicatorIds, hideIndicatorIds, once, onEnd,
    } = options;

    const showIndicatorIdList = showIndicatorIds ? Xml.splitAttributeList(showIndicatorIds) : [];
    const hideIndicatorIdList = hideIndicatorIds ? Xml.splitAttributeList(hideIndicatorIds) : [];

    if (once) {
      if (behaviorElement.getAttribute('ran-once')) {
        // This action is only supposed to run once, and it already ran,
        // so there's nothing more to do.
        if (typeof onEnd === 'function') {
          onEnd();
        }
        return;
      }
      behaviorElement.setAttribute('ran-once', 'true');
    }

    let newRoot = this.doc;
    if (showIndicatorIdList || hideIndicatorIdList){
      newRoot = Behaviors.setIndicatorsBeforeLoad(showIndicatorIdList, hideIndicatorIdList, newRoot);
    }

    // Re-render the modifications
    this.needsLoad = true;
    this.setState({
      doc: newRoot,
      elementError: null,
      error: null,
      url,
    });
  }

  /**
   * Renders the XML doc into React components. Shows blank screen until the XML doc is available.
   */
  render() {
    if (this.state.error) {
      const errorScreen = this.props.errorScreen || LoadError;
      return React.createElement(errorScreen, {
        back: () => this.getNavigation().back(),
        error: this.state.error,
        onPressReload: () => this.reload(),  // Make sure reload() is called without any args
        onPressViewDetails: (uri) => this.props.openModal({ url: uri }),
      });
    }
    if (!this.state.doc) {
      const loadingScreen = this.props.loadingScreen || Loading;
      return React.createElement(loadingScreen);
    }
    const elementErrorComponent = this.state.elementError ? this.props.elementErrorComponent || LoadElementError : null;
    const [body] = Array.from(this.state.doc.getElementsByTagNameNS(Namespaces.HYPERVIEW, 'body'));
    const screenElement = Render.renderElement(
      body,
      this.state.styles,
      this.onUpdate,
      {
        componentRegistry: this.componentRegistry,
        screenUrl: this.state.url,
        staleHeaderType: this.state.staleHeaderType,
      },
    );

    return (
      <Contexts.DocContext.Provider value={() => this.doc}>
        <Contexts.DateFormatContext.Provider value={this.props.formatDate}>
          {screenElement}
          {elementErrorComponent ? (React.createElement(elementErrorComponent, { error: this.state.elementError, onPressReload: () => this.reload() })) : null}
        </Contexts.DateFormatContext.Provider>
      </Contexts.DocContext.Provider>
    );
  }

  /**
   * Checks if `once` is previously applied.
   */
  isOncePreviouslyApplied = (behaviorElement) => {
    const once = behaviorElement.getAttribute('once');
    const ranOnce = behaviorElement.getAttribute('ran-once');
    if (once === 'true' && ranOnce === 'true') {
        return true;
    }
    return false;
  }

  setRanOnce = (behaviorElement) => {
    behaviorElement.setAttribute('ran-once', 'true');
  }

  /**
   * Returns a navigation object similar to the one provided by React Navigation,
   * but connected to props injected by the parent app.
   */
  getNavigation = () => ({
    back: this.props.back,
    closeModal: this.props.closeModal,
    navigate: this.props.navigate,
    openModal: this.props.openModal,
    push: this.props.push,
  })

  /**
   * Fetches the provided reference.
   * - If the references is an id reference (starting with #),
   *   returns a clone of that element.
   * - If the reference is a full URL, fetches the URL.
   * - If the reference is a path, fetches the path from the host of the URL
   *   used to render the screen.
   * Returns a promise that resolves to a DOM element.
   */
  fetchElement = async (href, method, root, formData) => {
    if (href[0] === '#') {
      const element = root.getElementById(href.slice(1));
      if (element) {
        return element.cloneNode(true);
      }
      throw new Error(`Element with id ${href} not found in document`);
    }

    try {
      const url = UrlService.getUrlFromHref(href, this.state.url, method);
      const { doc, staleHeaderType } = await this.parser.loadElement(url, formData, method);
      if (staleHeaderType) {
        // We are doing this to ensure that we keep the screen stale until a `reload` happens
        this.setState({ staleHeaderType });
      }
      if (this.state.elementError) {
        this.setState({ elementError: null });
      }
      return doc.documentElement;
    } catch (err) {
      if (this.props.onError) {
        this.props.onError(err);
      }
      this.setState({ elementError: err });
    }
    return null;
  }

  registerPreload = (id, element) => {
    if (this.props.registerPreload){
      this.props.registerPreload(id, element);
    }
  }

  /**
   *
   */
  onUpdate = (href, action, currentElement, opts) => {
    if (action === ACTIONS.RELOAD) {
      this.reload(href, opts);
    } else if (action === ACTIONS.DEEP_LINK) {
      Linking.openURL(href);
    } else if (Object.values(NAV_ACTIONS).includes(action)) {
      this.navigation.setUrl(this.state.url);
      this.navigation.setDocument(this.doc);
      this.navigation.navigate(href || ANCHOR_ID_SEPARATOR, action, currentElement, this.formComponentRegistry, opts, this.registerPreload);
    } else if (Object.values(UPDATE_ACTIONS).includes(action)) {
      this.onUpdateFragment(href, action, currentElement, opts);
    } else if (action === ACTIONS.SWAP) {
      this.onSwap(currentElement, opts.newElement);
    } else if (action === ACTIONS.DISPATCH_EVENT) {
      const { behaviorElement } = opts;
      const eventName = behaviorElement.getAttribute('event-name');
      const trigger = behaviorElement.getAttribute('trigger');
      const delay = behaviorElement.getAttribute('delay');

      if (this.isOncePreviouslyApplied(behaviorElement)) {
        return;
      }

      this.setRanOnce(behaviorElement);

      // Check for event loop formation
      if (trigger === 'on-event') {
        throw new Error('trigger="on-event" and action="dispatch-event" cannot be used on the same element');
      }
      if (!eventName) {
        throw new Error('dispatch-event requires an event-name attribute to be present');
      }

      const dispatch = () => {
        Events.dispatch(eventName);
      }

      if (delay) {
        setTimeout(dispatch, parseInt(delay, 10));
      } else {
        dispatch();
      }
    } else {
      const { behaviorElement } = opts;
      this.onCustomUpdate(behaviorElement);
    }
  }

  /**
   * Handler for behaviors on the screen.
   * @param href {string} A reference to the XML to fetch. Can be local (via id reference prepended
   *        by #) or a
   * remote resource.
   * @param action {string} The name of the action to perform with the returned XML.
   * @param currentElement {Element} The XML DOM element triggering the behavior.
   * @param options {Object} Optional attributes:
   *  - verb: The HTTP method to use for the request
   *  - targetId: An id reference of the element to apply the action to. Defaults to currentElement
   *    if not provided.
   *  - showIndicatorIds: Space-separated list of id references to show during the fetch.
   *  - hideIndicatorIds: Space-separated list of id references to hide during the fetch.
   *  - delay: Minimum time to wait to fetch the resource. Indicators will be shown/hidden during
   *    this time.
   *  - once: If true, the action should only trigger once. If already triggered, onUpdate will be
   *    a no-op.
   *  - onEnd: Callback to run when the resource is fetched.
   *  - behaviorElement: The behavior element triggering the behavior. Can be different from
   *    the currentElement.
   */
  onUpdateFragment = (href, action, currentElement, opts) => {
    const options = opts || {};
    const {
      behaviorElement, verb, targetId, showIndicatorIds, hideIndicatorIds, delay, once, onEnd,
    } = options;

    const showIndicatorIdList = showIndicatorIds ? Xml.splitAttributeList(showIndicatorIds) : [];
    const hideIndicatorIdList = hideIndicatorIds ? Xml.splitAttributeList(hideIndicatorIds) : [];

    const formData = getFormData(currentElement, this.formComponentRegistry);

    if (once) {
      if (behaviorElement.getAttribute('ran-once')) {
        // This action is only supposed to run once, and it already ran,
        // so there's nothing more to do.
        if (typeof onEnd === 'function') {
          onEnd();
        }
        return;
      }
      behaviorElement.setAttribute('ran-once', 'true');

    }

    let newRoot = this.doc;
    newRoot = Behaviors.setIndicatorsBeforeLoad(showIndicatorIdList, hideIndicatorIdList, newRoot);
    // Re-render the modifications
    this.setState({
      doc: newRoot,
    });

    // Fetch the resource, then perform the action on the target and undo indicators.
    const fetchAndUpdate = () => this.fetchElement(href, verb, newRoot, formData)
      .then((newElement) => {
        // If a target is specified and exists, use it. Otherwise, the action target defaults
        // to the element triggering the action.
        let targetElement = targetId ? this.doc?.getElementById(targetId) : currentElement;
        if (!targetElement) {
          targetElement = currentElement;
        }

        if (newElement) {
          newRoot = Behaviors.performUpdate(action, targetElement, newElement);
        } else {
          // When fetch fails, make sure to get the latest version of the doc to avoid any race conditions
          newRoot = this.doc;
        }
        newRoot = Behaviors.setIndicatorsAfterLoad(showIndicatorIdList, hideIndicatorIdList, newRoot);
        // Re-render the modifications
        this.setState({
          doc: newRoot,
        });

        if (typeof onEnd === 'function') {
          onEnd();
        }
      });

    if (delay) {
      /**
       * Delayed behaviors will only trigger after a given amount of time.
       * During that time, the DOM may change and the triggering element may no longer
       * be in the document. When that happens, we don't want to trigger the behavior after the time
       * elapses. To track this, we store the timeout id (generated by setTimeout) on the triggering
       * element, and then look it up in the document after the elapsed time. If the timeout id is not
       * present, we update the indicators but don't execute the behavior.
       */
      const delayMs = parseInt(delay, 10);
      let timeoutId = null;
      timeoutId = setTimeout(() => {
        // Check the current doc for an element with the same timeout ID
        const timeoutElement = getElementByTimeoutId(this.doc, timeoutId.toString());
        if (timeoutElement) {
          // Element with the same ID exists, we can execute the behavior
          removeTimeoutId(timeoutElement);
          fetchAndUpdate();
        } else {
          // Element with the same ID does not exist, we don't execute the behavior and undo the indicators.
          newRoot = Behaviors.setIndicatorsAfterLoad(showIndicatorIdList, hideIndicatorIdList, this.doc);
          this.setState({
            doc: newRoot,
          });
          if (typeof onEnd === 'function') {
            onEnd();
          }
        }
      }, delayMs);
      // Store the timeout ID
      setTimeoutId(currentElement, timeoutId.toString());
    } else {
      // If there's no delay, fetch immediately and update the doc when done.
      fetchAndUpdate();
    }
  }

  /**
   * Used internally to update the state of things like select forms.
   */
  onSwap = (currentElement, newElement) => {
    const parentElement = currentElement.parentNode;
    parentElement.replaceChild(newElement, currentElement);
    const newRoot = shallowCloneToRoot(parentElement);
    this.setState({
      doc: newRoot,
    });
  }

  /**
   * Extensions for custom behaviors.
   */
  onCustomUpdate = (behaviorElement) => {
    const action = behaviorElement.getAttribute('action');
    const behavior = this.behaviorRegistry[action];

    if (this.isOncePreviouslyApplied(behaviorElement)) {
      return;
    }

    this.setRanOnce(behaviorElement);

    if (behavior) {
      const updateRoot = (newRoot, updateStylesheet = false) => updateStylesheet
        ? this.setState({ doc: newRoot, styles: Stylesheets.createStylesheets(newRoot) })
        : this.setState({ doc: newRoot });
      const getRoot = () => this.doc;
      behavior.callback(behaviorElement, this.onUpdate, getRoot, updateRoot);
    } else {
      // No behavior detected.
      console.warn(`No behavior registered for action "${action}"`);
    }
  }
}

export * from 'hyperview/src/types';
export { Events, Namespaces };
