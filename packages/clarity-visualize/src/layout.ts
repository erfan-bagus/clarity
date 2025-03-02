import { Data, Layout } from "clarity-decode";
import { Asset, Constant, NodeType, Setting } from "@clarity-types/visualize";
import { state } from "./clarity";

const TIMEOUT = 3000;
let stylesheets: Promise<void>[] = [];
let nodes = {};
let events = {};

export function reset(): void {
    nodes = {};
    stylesheets = [];
    events = {};
}

export function get(hash: string): Element {
    let doc = state.window.document;
    return doc.querySelector(`[${Constant.Hash}="${hash}"]`);
}

export function box(event: Layout.BoxEvent): void {
    let data = event.data;
    for (let b of data) {
        let el = element(b.id) as HTMLElement;
        resize(el, b.width, b.height);
    }
}

function resize(el: HTMLElement, width: number, height: number): void {
    if (el && el.nodeType === NodeType.ELEMENT_NODE && width && height) {
        el.style.width = width + Layout.Constant.Pixel;
        el.style.height = height + Layout.Constant.Pixel;
        el.style.boxSizing = Layout.Constant.BorderBox; // Reference: https://developer.mozilla.org/en-US/docs/Web/CSS/box-sizing
    }
}

export function element(nodeId: number): Node {
    return nodeId !== null && nodeId > 0 && nodeId in nodes ? nodes[nodeId] : null;
}

export async function dom(event: Layout.DomEvent): Promise<void> {
    if (event) {
        // When setting up rendering for the first time, start off with hidden target window
        // This ensures we do not show flickers to the end user
        let doc = state.window.document;
        if (doc && doc.documentElement) {
            doc.documentElement.style.visibility = Constant.Hidden;
            // Render all DOM events to reconstruct the page
            markup(event);
            // Wait on all stylesheets to finish loading
            await Promise.all(stylesheets);
            // Toggle back the visibility of target window
            doc.documentElement.style.visibility = Constant.Visible;
        }
    }
}

export function exists(hash: string): boolean {
    if (hash) {
        let doc = state.window.document;
        let match = doc.querySelector(`[${Constant.Hash}="${hash}"]`);
        if (match) {
            let rectangle = match.getBoundingClientRect();
            return rectangle && rectangle.width > 0 && rectangle.height > 0;
        }
    }
    return false;
}

export function markup(event: Layout.DomEvent): void {
    let data = event.data;
    let type = event.event;
    let doc = state.window.document;
    for (let node of data) {
        let parent = element(node.parent);
        let pivot = element(node.previous);
        let insert = insertAfter;

        let tag = node.tag;
        if (tag && tag.indexOf(Layout.Constant.IFramePrefix) === 0) { tag = node.tag.substr(Layout.Constant.IFramePrefix.length); }
        switch (tag) {
            case Layout.Constant.DocumentTag:
                let tagDoc = tag !== node.tag ? (parent ? (parent as HTMLIFrameElement).contentDocument : null): doc;
                if (tagDoc && tagDoc === doc && type === Data.Event.Discover) { reset(); }
                if (typeof XMLSerializer !== "undefined" && tagDoc) {
                    tagDoc.open();
                    tagDoc.write(new XMLSerializer().serializeToString(
                        tagDoc.implementation.createDocumentType(
                            node.attributes["name"],
                            node.attributes["publicId"],
                            node.attributes["systemId"]
                        )
                    ));
                    tagDoc.close();
                }
                break;
            case Layout.Constant.PolyfillShadowDomTag:
                // In case of polyfill, map shadow dom to it's parent for rendering purposes
                // All its children should be inserted as regular children to the parent node.
                nodes[node.id] = parent;
                break;
            case Layout.Constant.ShadowDomTag:
                if (parent) {
                    let shadowRoot = element(node.id);
                    shadowRoot = shadowRoot ? shadowRoot : (parent as HTMLElement).attachShadow({ mode: "open" });
                    if ("style" in node.attributes) {
                        let shadowStyle = doc.createElement("style");
                        // Support for adoptedStyleSheet is limited and not available in all browsers.
                        // To ensure that we can replay session in any browser, we turn adoptedStyleSheets from recording
                        // into classic style tags at the playback time.
                        if (shadowRoot.firstChild && (shadowRoot.firstChild as HTMLElement).id === Constant.AdoptedStyleSheet) {
                            shadowStyle = shadowRoot.firstChild as HTMLStyleElement;
                        }
                        shadowStyle.id = Constant.AdoptedStyleSheet;
                        shadowStyle.textContent = node.attributes["style"];
                        shadowRoot.appendChild(shadowStyle);
                    }
                    nodes[node.id] = shadowRoot;
                }
                break;
            case Layout.Constant.TextTag:
                let textElement = element(node.id);
                textElement = textElement ? textElement : doc.createTextNode(null);
                textElement.nodeValue = node.value;
                insert(node, parent, textElement, pivot);
                break;
            case Layout.Constant.SuspendMutationTag:
                let suspendedElement = element(node.id);
                if (suspendedElement && suspendedElement.nodeType === Node.ELEMENT_NODE) {
                    (suspendedElement as HTMLElement).setAttribute(Constant.Suspend, Layout.Constant.Empty);
                }
                break;
            case "HTML":
                let htmlDoc = tag !== node.tag ? (parent ? (parent as HTMLIFrameElement).contentDocument : null): doc;
                if (htmlDoc !== null) {
                    let docElement = element(node.id) as HTMLElement;
                    if (docElement === null) {
                        let newDoc = htmlDoc.implementation.createHTMLDocument(Layout.Constant.Empty);
                        docElement = newDoc.documentElement;
                        let p = htmlDoc.importNode(docElement, true);
                        htmlDoc.replaceChild(p, htmlDoc.documentElement);
                        if (htmlDoc.head) { htmlDoc.head.parentNode.removeChild(htmlDoc.head); }
                        if (htmlDoc.body) { htmlDoc.body.parentNode.removeChild(htmlDoc.body); }
                    }
                    setAttributes(htmlDoc.documentElement, node);
                    // If we are still processing discover events, keep the markup hidden until we are done
                    if (type === Data.Event.Discover) { htmlDoc.documentElement.style.visibility = Constant.Hidden; }
                    nodes[node.id] = htmlDoc.documentElement;
                }
                break;
            case "HEAD":
                let headElement = element(node.id);
                if (headElement === null) {
                    headElement = doc.createElement(node.tag);
                    if (node.attributes && Layout.Constant.Base in node.attributes) {
                        let base = doc.createElement("base");
                        base.href = node.attributes[Layout.Constant.Base];
                        headElement.appendChild(base);
                    }

                    // Add custom styles to assist with visualization
                    let custom = doc.createElement("style");
                    custom.innerText = getCustomStyle();
                    headElement.appendChild(custom);
                }
                setAttributes(headElement as HTMLElement, node);
                insert(node, parent, headElement, pivot);
                break;
            case "LINK":
                let linkElement = element(node.id) as HTMLLinkElement;
                linkElement = linkElement ? linkElement : createElement(doc, node.tag) as HTMLLinkElement;
                if (!node.attributes) { node.attributes = {}; }
                setAttributes(linkElement as HTMLElement, node);
                if ("rel" in node.attributes && node.attributes["rel"] === "stylesheet") {
                    stylesheets.push(new Promise((resolve: () => void): void => {
                        linkElement.onload = linkElement.onerror = style.bind(this, linkElement, resolve);
                        setTimeout(resolve, TIMEOUT);
                    }));
                }
                insert(node, parent, linkElement, pivot);
                break;
            case "STYLE":
                let styleElement = element(node.id) as HTMLStyleElement;
                styleElement = styleElement ? styleElement : doc.createElement(node.tag) as HTMLStyleElement;
                setAttributes(styleElement as HTMLElement, node);
                styleElement.textContent = node.value;
                insert(node, parent, styleElement, pivot);
                style(styleElement);
                break;
            case "IFRAME":
                let iframeElement = element(node.id) as HTMLElement;
                iframeElement = iframeElement ? iframeElement : createElement(doc, node.tag);
                if (!node.attributes) { node.attributes = {}; }
                setAttributes(iframeElement as HTMLElement, node);
                insert(node, parent, iframeElement, pivot);
                break;
            default:
                let domElement = element(node.id) as HTMLElement;
                domElement = domElement ? domElement : createElement(doc, node.tag);
                setAttributes(domElement as HTMLElement, node);
                resize(domElement, node.width, node.height);
                insert(node, parent, domElement, pivot);
                break;
        }
        // Track state for this node
        if (node.id) { events[node.id] = node; }
    }
}

function style(node: HTMLLinkElement | HTMLStyleElement, resolve: () => void = null): void {
    // Firefox throws a SecurityError when trying to access cssRules of a stylesheet from a different domain
    try {
        const sheet = node.sheet as CSSStyleSheet;
        let cssRules = sheet ? sheet.cssRules : [];
        for (let i = 0; i < cssRules.length; i++) {
            if (cssRules[i].cssText.indexOf(Constant.Hover) >= 0) {
                let css = cssRules[i].cssText.replace(/:hover/g, `[${Constant.CustomHover}]`);
                sheet.removeRule(i);
                sheet.insertRule(css, i);
            }
        }
    } catch { /* do nothing */ }

    if (resolve) { resolve(); }
}

function createElement(doc: Document, tag: string): HTMLElement {
    if (tag && tag.indexOf(Layout.Constant.SvgPrefix) === 0) {
        return doc.createElementNS(Layout.Constant.SvgNamespace as string, tag.substr(Layout.Constant.SvgPrefix.length)) as HTMLElement;
    }
    try { return doc.createElement(tag); } catch (ex) {
        // We log the warning on non-standard markup but continue with the visualization
        console.warn(`Exception encountered while creating element ${tag}: ${ex}`);
        return doc.createElement(Constant.UnknownTag);
    };
}

function insertAfter(data: Layout.DomData, parent: Node, node: Node, previous: Node): void {
    // Skip over no-op changes where parent and previous element is still the same
    // In case of IFRAME, re-adding DOM at the exact same place will lead to loss of state and the markup inside will be destroyed
    if (events[data.id] && events[data.id].parent === data.parent && events[data.id].previous === data.previous) { return; }
    let next = previous && previous.parentElement === parent ? previous.nextSibling : null;
    next = previous === null && parent ? firstChild(parent) : next;
    insertBefore(data, parent, node, next);
}

function firstChild(node: Node): ChildNode {
    let child = node.firstChild;
    // BASE tag should always be the first child to ensure resources with relative URLs are loaded correctly
    if (child && child.nodeType === NodeType.ELEMENT_NODE && (child as HTMLElement).tagName === Layout.Constant.BaseTag) {
        return child.nextSibling;
    }
    return child;
}

function insertBefore(data: Layout.DomData, parent: Node, node: Node, next: Node): void {
    if (parent !== null) {
        next = next && next.parentElement !== parent ? null : next;
        try {
            parent.insertBefore(node, next);
        } catch (ex) {
            console.warn("Node: " + node + " | Parent: " + parent + " | Data: " + JSON.stringify(data));
            console.warn("Exception encountered while inserting node: " + ex);
        }
    } else if (parent === null && node.parentElement !== null) {
        node.parentElement.removeChild(node);
    }
    nodes[data.id] = node;
}

function setAttributes(node: HTMLElement, data: Layout.DomData): void {
    let attributes = data.attributes || {};
    let sameorigin = false;

    // Clarity attributes
    attributes[Constant.Id] = `${data.id}`;
    attributes[Constant.Hash] = `${data.hash}`;

    let tag = node.nodeType === NodeType.ELEMENT_NODE ? node.tagName.toLowerCase() : null;
    // First remove all its existing attributes
    if (node.attributes) {
        let length = node.attributes.length;
        while (node.attributes && length > 0) {
            // Do not remove "clarity-hover" attribute and let it be managed by interaction module
            // This helps avoid flickers during visualization
            if (node.attributes[0].name !== Constant.HoverAttribute) {
                node.removeAttribute(node.attributes[0].name);
            }
            length--;
        }
    }

    // Add new attributes
    for (let attribute in attributes) {
        if (attributes[attribute] !== undefined) {
            try {
                let v = attributes[attribute];
                if (attribute.indexOf("xlink:") === 0) {
                    node.setAttributeNS("http://www.w3.org/1999/xlink", attribute, v);
                } else if (attribute.indexOf(Layout.Constant.SameOrigin) === 0) {
                    sameorigin = true;
                } else if (attribute.indexOf("*") === 0) {
                    // Do nothing if we encounter internal Clarity attributes
                } else if (tag === Constant.IFrameTag && (attribute.indexOf("src") === 0 || attribute.indexOf("allow") === 0) || attribute === "sandbox") {
                    node.setAttribute(`data-clarity-${attribute}`, v);
                } else if (tag === Constant.ImageTag && attribute.indexOf("src") === 0 && (v === null || v.length === 0)) {
                    node.setAttribute(attribute, Asset.Transparent);
                    let size = Constant.Large;
                    if (data.width) {
                        size = data.width <= Setting.Medium ? Constant.Medium : (data.width <= Setting.Small ? Constant.Small : size);
                    }
                    node.setAttribute(Constant.Hide, size);
                } else {
                    node.setAttribute(attribute, v);
                }
            } catch (ex) {
                console.warn("Node: " + node + " | " + JSON.stringify(attributes));
                console.warn("Exception encountered while adding attributes: " + ex);
            }
        }
    }

    if (sameorigin === false && tag === Constant.IFrameTag && typeof node.setAttribute == Constant.Function) {
        node.setAttribute(Constant.Unavailable, Layout.Constant.Empty);
    }

    // Add an empty ALT tag on all IMG elements
    if (tag === Constant.ImageTag && !node.hasAttribute(Constant.AltAttribute)) { node.setAttribute(Constant.AltAttribute, Constant.Empty); }
}

function getCustomStyle(): string {
    // tslint:disable-next-line: max-line-length
    return `${Constant.ImageTag}[${Constant.Hide}] { background-color: #CCC; background-image: url(${Asset.Hide}); background-repeat:no-repeat; background-position: center; }` +
        `${Constant.ImageTag}[${Constant.Hide}=${Constant.Small}] { background-size: 18px 18px; }` +
        `${Constant.ImageTag}[${Constant.Hide}=${Constant.Medium}] { background-size: 24px 24px; }` +
        `${Constant.ImageTag}[${Constant.Hide}=${Constant.Large}] { background-size: 36px 36px; }` +
        `${Constant.IFrameTag}[${Constant.Unavailable}] { background: url(${Asset.Unavailable}) no-repeat center center, url('${Asset.Cross}'); }` +
        `*[${Constant.Suspend}] { filter: grayscale(100%); }`;
}
