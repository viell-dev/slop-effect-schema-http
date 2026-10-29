import javax.xml.soap.SOAPConstants;
import javax.xml.soap.SOAPMessage;
import javax.xml.ws.Provider;
import javax.xml.ws.Service;
import javax.xml.ws.ServiceMode;
import javax.xml.ws.WebServiceProvider;

/** The SOAP 1.1 endpoint: the default binding. */
@WebServiceProvider(serviceName = "DocVault", portName = "DocVaultSoap", targetNamespace = Store.NAMESPACE)
@ServiceMode(Service.Mode.MESSAGE)
public class Soap11 implements Provider<SOAPMessage> {
    @Override
    public SOAPMessage invoke(SOAPMessage request) {
        return Store.lock(request, SOAPConstants.SOAP_1_1_PROTOCOL);
    }
}
