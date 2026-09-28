package com.dhabpari.app;

// window.print() inside the app's WebView (receiptExport.ts's
// printViaHiddenIframe) does nothing on Android: Capacitor's BridgeWebView
// has no print support wired up, and there was no host-side PrintManager
// integration at all, so every "Print" button in the app (reports/account
// statements, receipts, invoices, employee documents, meeting minutes) was a
// silent no-op on the native APK -- tap it and nothing happens, no dialog,
// no error -- even though the exact same button works fine in a real
// browser tab. Real report, 2026-09-28.
//
// Two entry points, matching the two things the web side already produces:
//   - printHtml: the reports/statement print flow clones a DOM node into an
//     HTML string (receiptExport.ts's printNodeInPopup) -- rendered here in
//     an off-screen WebView purely so Android's PrintManager can rasterize
//     it via that WebView's own createPrintDocumentAdapter().
//   - printPdf: receipts/invoices/employee docs are already rendered
//     client-side into a PDF blob (jsPDF, receiptExport.ts's printBlob) --
//     no need to re-render anything, the PDF bytes are just streamed
//     straight through a minimal PrintDocumentAdapter.
//
// Registered explicitly in MainActivity -- see AppSettingsPlugin's own
// header comment for why this project doesn't rely on Capacitor's plugin
// auto-discovery.

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

@CapacitorPlugin(name = "NativePrint")
public class PrintPlugin extends Plugin {

    // Printing an HTML clone needs a live WebView, and the system print
    // dialog reads from its PrintDocumentAdapter asynchronously -- well
    // after this method has already returned -- so it's kept alive here as
    // a field rather than a local variable, or it would be eligible for
    // garbage collection mid-job. Never attached to any visible layout;
    // Android renders/rasterizes an unattached WebView for printing fine.
    private WebView printWebView;

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        String jobName = call.getString("jobName", "Document");
        if (html == null) {
            call.reject("html is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                printWebView = new WebView(getContext());
                printWebView.setWebViewClient(new WebViewClient() {
                    private boolean handled = false;

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        // Guard against a second onPageFinished (e.g. a
                        // sub-frame) firing a duplicate print job / a second
                        // call.resolve() on the same PluginCall.
                        if (handled) return;
                        handled = true;
                        PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                        if (printManager == null) {
                            call.reject("Printing is not available on this device");
                            return;
                        }
                        PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
                        printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                        call.resolve();
                    }
                });
                printWebView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                call.reject("Could not print: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void printPdf(PluginCall call) {
        String base64Data = call.getString("base64Data");
        String jobName = call.getString("jobName", "Document");
        if (base64Data == null) {
            call.reject("base64Data is required");
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
            if (printManager == null) {
                call.reject("Printing is not available on this device");
                return;
            }
            printManager.print(jobName, new PrintDocumentAdapter() {
                @Override
                public void onLayout(PrintAttributes oldAttrs, PrintAttributes newAttrs, CancellationSignal cancellationSignal, LayoutResultCallback callback, Bundle extras) {
                    if (cancellationSignal.isCanceled()) {
                        callback.onLayoutCancelled();
                        return;
                    }
                    PrintDocumentInfo info = new PrintDocumentInfo.Builder(jobName)
                        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                        .build();
                    callback.onLayoutFinished(info, true);
                }

                @Override
                public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellationSignal, WriteResultCallback callback) {
                    try (InputStream input = new ByteArrayInputStream(bytes);
                         FileOutputStream output = new FileOutputStream(destination.getFileDescriptor())) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = input.read(buf)) >= 0) {
                            if (cancellationSignal.isCanceled()) {
                                callback.onWriteCancelled();
                                return;
                            }
                            output.write(buf, 0, n);
                        }
                        callback.onWriteFinished(new PageRange[]{ PageRange.ALL_PAGES });
                    } catch (IOException e) {
                        callback.onWriteFailed(e.getMessage());
                    }
                }
            }, new PrintAttributes.Builder().build());
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not print: " + e.getMessage(), e);
        }
    }
}
