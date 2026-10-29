import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * POST /v1/customers the way the business API's 2012 controller answers a creation, with the new
 * resource's path written by the handler. The `variant` query parameter chooses how the handler
 * hands the path to the container:
 *
 * <ul>
 *   <li>none: setHeader("Location", path) on a 200 with the JSON acknowledgement;
 *   <li>{@code redirect}: sendRedirect(path), the call the Servlet specification makes the container
 *       resolve into an absolute URL;
 *   <li>{@code relative}: sendRedirect with a path relative to the request's own;
 *   <li>{@code redirect-then-200}: sendRedirect(path), then setStatus(200) and the acknowledgement.
 * </ul>
 */
public class Customers extends HttpServlet {
    private static final String PATH = "/v1/customers/1006";

    @Override
    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws IOException {
        String variant = request.getParameter("variant");
        if ("redirect".equals(variant)) {
            response.sendRedirect(PATH);
        } else if ("relative".equals(variant)) {
            response.sendRedirect("customers/1006");
        } else if ("redirect-then-200".equals(variant)) {
            response.sendRedirect(PATH);
            response.setStatus(HttpServletResponse.SC_OK);
            acknowledge(response);
        } else {
            response.setStatus(HttpServletResponse.SC_OK);
            response.setHeader("Location", PATH);
            acknowledge(response);
        }
    }

    private static void acknowledge(HttpServletResponse response) throws IOException {
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"success\":true}");
    }
}
