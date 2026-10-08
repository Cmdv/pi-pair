;;; emacs-replay.el --- Offline adapter envelope replay -*- lexical-binding: t; -*-
;; Invoked by emacs.test.ts in a disposable project, without user init files.
(require 'pi)

(let* ((requests-file (pop command-line-args-left))
       (replies-file (pop command-line-args-left))
       (cli (pop command-line-args-left))
       (core (pop command-line-args-left))
       ;; A chat input on screen, as in a real session: code opens beside it, and focus stays there.
       (input (switch-to-buffer (get-buffer-create "*pi input: replay*")))
       (session (pi-session--make :directory default-directory :input input))
       (source (find-file-noselect (expand-file-name "code.txt")))
       (requests (with-temp-buffer
                   (insert-file-contents requests-file)
                   (json-parse-buffer :object-type 'alist :array-type 'list)))
       replies events)
  (with-current-buffer source
    (goto-char (point-max))
    (insert "unsaved\n"))
  (cl-letf (((symbol-function 'pi--respond)
             (lambda (_session id fields)
               (push `((id . ,id) (value . ,(alist-get 'value fields))
                       (count . ,(hash-table-count (pi-session-annotations session))))
                     replies))))
    (dolist (request requests) (pi--ui-request session request)))
  ;; Now exercise the real core's handshake and local clear command, no model.
  (let* ((pi-rpc-program cli)
         (process-environment (cons "PI_PAIR_EDITOR=emacs" process-environment))
         (process (pi-rpc-start
                   default-directory
                   :arguments (list "--offline" "--no-session" "--no-extensions"
                                    "--no-skills" "--no-prompt-templates" "--no-themes"
                                    "--no-context-files" "--no-tools" "--no-approve"
                                    "--extension" core)
                   :on-record (lambda (process record)
                                (push record events)
                                (pi--on-record process record)))))
    (setf (pi-session-process session) process)
    (process-put process 'pi-session session)
    (unwind-protect
        (progn
          (pi--annotate session '((id . "real-clear") (path . "code.txt")
                                 (start_line . 3) (end_line . 3)
                                 (note . "Clear this through real RPC") (kind . "note")))
          ;; /pair asks for a spec; answer No spec.
          (cl-letf (((symbol-function 'pi--open-dialog)
                     (lambda (_session _request &rest args)
                       (funcall (plist-get args :callback) "No spec"))))
            (dolist (command '("/pair" "/pair:clear all"))
              (let ((response (pi-rpc-request-sync
                               process "prompt" `((message . ,command)) 15)))
                (unless (alist-get 'success response)
                  (error "Core rejected %s: %S" command response)))))
          (unless (zerop (hash-table-count (pi-session-annotations session)))
            (error "Core clear did not remove the annotation")))
      (delete-process process)))
  (with-temp-file replies-file
    (insert (json-encode `((replies . ,(vconcat (nreverse replies)))
                          (events . ,(vconcat (nreverse events)))
                          (text . ,(with-current-buffer source (buffer-string)))
                          (modified . ,(if (buffer-modified-p source) t :json-false)))))))
