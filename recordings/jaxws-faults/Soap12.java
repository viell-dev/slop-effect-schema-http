import javax.xml.soap.SOAPConstants;
import javax.xml.soap.SOAPMessage;
import javax.xml.ws.BindingType;
import javax.xml.ws.Provider;
import javax.xml.ws.Service;
import javax.xml.ws.ServiceMode;
import javax.xml.ws.WebServiceProvider;
import javax.xml.ws.soap.SOAPBinding;

/** The SOAP 1.2 endpoint: the SOAP 1.2 HTTP binding. */
@WebServiceProvider(serviceName = "DocVault", portName = "DocVaultSoap12", targetNamespace = Store.NAMESPACE)
@ServiceMode(Service.Mode.MESSAGE)
@BindingType(SOAPBinding.SOAP12HTTP_BINDING)
public class Soap12 implements Provider<SOAPMessage> {
    @Override
    public SOAPMessage invoke(SOAPMessage request) {
        return Store.lock(request, SOAPConstants.SOAP_1_2_PROTOCOL);
    }
}
