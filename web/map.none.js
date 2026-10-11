// For builds that cannot reach a map service: the Map view and looking places up are left out.
export const hasMap = false;

export const createMap = () => ({ show() {}, lookAt() {}, fit() {}, resize() {} });

export const lookUp = async () => [];
