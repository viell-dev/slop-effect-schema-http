import javax.xml.namespace.QName;
import javax.xml.soap.SOAPBody;
import javax.xml.soap.SOAPConstants;
import javax.xml.soap.SOAPElement;
import javax.xml.soap.SOAPException;
import javax.xml.soap.SOAPFactory;
import javax.xml.soap.SOAPFault;
import javax.xml.soap.SOAPMessage;
import javax.xml.ws.Endpoint;
import javax.xml.ws.WebServiceException;
import javax.xml.ws.soap.SOAPFaultException;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * DocVault's LockDocument, as far as it faults, on the JAX-WS reference implementation of JDK 8:
 * {@link Soap11} and {@link Soap12} are Provider endpoints published with {@link Endpoint#publish}
 * on the JDK's own HTTP server, for SOAP 1.1 at /soap and SOAP 1.2 at /soap12. Each fault is a
 * {@link SOAPFaultException} built with SAAJ, which the runtime serializes and sends.
 *
 * <p>The recording's data: DOC-000001 exists and archive-robot holds its lock until
 * 2026-11-01T12:05:00Z; no other document exists.
 */
public final class Store {
    static final String NAMESPACE = "urn:docvault:store:2003";

    private Store() {}

    public static void main(String[] arguments) {
        Endpoint.publish("http://0.0.0.0:8080/soap", new Soap11());
        Endpoint.publish("http://0.0.0.0:8080/soap12", new Soap12());
        System.out.println("published");
    }

    /** Answer a LockDocument call, or throw the fault the store answers it with. */
    static SOAPMessage lock(SOAPMessage request, String protocol) {
        try {
            boolean soap12 = SOAPConstants.SOAP_1_2_PROTOCOL.equals(protocol);
            String envelope = soap12
                    ? SOAPConstants.URI_NS_SOAP_1_2_ENVELOPE
                    : SOAPConstants.URI_NS_SOAP_1_1_ENVELOPE;
            QName sender = new QName(envelope, soap12 ? "Sender" : "Client");
            QName receiver = new QName(envelope, soap12 ? "Receiver" : "Server");
            SOAPFactory factory = SOAPFactory.newInstance(protocol);
            Element call = firstElement(request.getSOAPBody());
            String id = text(call, "Id");
            String owner = text(call, "Owner");
            if (id == null || owner == null || owner.trim().isEmpty()) {
                throw new SOAPFaultException(factory.createFault("Id and Owner are required", sender));
            }
            if (!"DOC-000001".equals(id)) {
                SOAPFault fault = factory.createFault("No document with id " + id, sender);
                fault.addDetail()
                        .addDetailEntry(new QName(NAMESPACE, "DocumentNotFound"))
                        .addChildElement(new QName(NAMESPACE, "Id"))
                        .addTextNode(id);
                throw new SOAPFaultException(fault);
            }
            if (!"archive-robot".equals(owner)) {
                SOAPFault fault = factory.createFault(
                        "Document DOC-000001 is locked by archive-robot", receiver);
                SOAPElement conflict = fault.addDetail()
                        .addDetailEntry(new QName(NAMESPACE, "LockConflict"));
                conflict.addChildElement(new QName(NAMESPACE, "HeldBy")).addTextNode("archive-robot");
                conflict.addChildElement(new QName(NAMESPACE, "Expires"))
                        .addTextNode("2026-11-01T12:05:00Z");
                throw new SOAPFaultException(fault);
            }
            throw new SOAPFaultException(factory.createFault("Not part of the recording", receiver));
        } catch (SOAPException cause) {
            throw new WebServiceException(cause);
        }
    }

    private static Element firstElement(SOAPBody body) {
        NodeList children = body.getChildNodes();
        for (int index = 0; index < children.getLength(); index++) {
            if (children.item(index).getNodeType() == Node.ELEMENT_NODE) {
                return (Element) children.item(index);
            }
        }
        return null;
    }

    private static String text(Element parent, String name) {
        if (parent == null) {
            return null;
        }
        NodeList found = parent.getElementsByTagNameNS(NAMESPACE, name);
        return found.getLength() == 0 ? null : found.item(0).getTextContent();
    }
}
