import { trappedProxy } from "../../thrown-values.js";

// oxlint-disable-next-line typescript/only-throw-error -- a thrown value whose instanceof check throws is the input under test
throw trappedProxy();
