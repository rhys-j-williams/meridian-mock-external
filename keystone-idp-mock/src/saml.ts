import { createPublicKey, createSign, KeyObject } from 'crypto';
import { SigningKeys } from './keys';

/**
 * SAML 2.0 stub for the legacy wealth portal (decommissioned 2023, integration never removed
 * from Keystone because the portal's SP metadata is still referenced by a compliance control).
 * The assertion is signed with the OIDC RSA key rather than a separate SAML certificate, and
 * there is no canonicalisation, so a real SP would reject the signature. Nothing in the estate
 * consumes it. Kept because the Keystone integration standard lists /saml/sso as a required
 * endpoint and the conformance checker pings it.
 */

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function samlMetadata(issuer: string, keys: SigningKeys): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${issuer}/saml">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:KeyName>${keys.kid}</ds:KeyName></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${issuer}/saml/sso"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${issuer}/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

export async function samlResponsePage(issuer: string, keys: SigningKeys, acs: string, nameId: string,
                                       relayState: string): Promise<string> {
  const now = new Date();
  const notAfter = new Date(now.getTime() + 5 * 60_000);
  const id = '_' + now.getTime().toString(16);
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">
    <saml:Issuer>${issuer}/saml</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${notAfter.toISOString()}" Recipient="${acs}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${notAfter.toISOString()}">
      <saml:AudienceRestriction><saml:Audience>urn:meridian:wealth-portal</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${now.toISOString()}">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
  </saml:Assertion>`;

  const signer = createSign('RSA-SHA256');
  signer.update(assertion);
  const signature = signer.sign(keys.privateKey as KeyObject, 'base64');
  const spki = createPublicKey(keys.privateKey as KeyObject).export({ type: 'spki', format: 'pem' }).toString();
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}r" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${acs}">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}/saml</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  ${assertion}
  <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <ds:SignedInfo><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#${id}"/></ds:SignedInfo>
    <ds:SignatureValue>${signature}</ds:SignatureValue>
    <ds:KeyInfo><ds:KeyName>${keys.kid}</ds:KeyName><ds:KeyValue>${base64(spki)}</ds:KeyValue></ds:KeyInfo>
  </ds:Signature>
</samlp:Response>`;

  return `<!doctype html><html><head><title>Redirecting to the wealth portal</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${acs}">
<input type="hidden" name="SAMLResponse" value="${base64(response)}">
<input type="hidden" name="RelayState" value="${relayState.replace(/"/g, '&quot;')}">
<noscript><button type="submit">Continue</button></noscript>
</form></body></html>`;
}
