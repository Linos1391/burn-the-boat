import { Button } from "@/components/ui/button"
import { ArrowRight, Sailboat, UsersRound } from "lucide-react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export default function HomePage() {
  return (
    <Empty className="flex">
      <EmptyHeader className="gap-4">
        <EmptyMedia
          variant="icon"
          className="mb-0 size-16 rounded-2xl bg-primary/10 text-primary [&_svg]:size-7"
        >
          <Sailboat aria-hidden="true" />
        </EmptyMedia>
        <div className="flex flex-col gap-2">
          <EmptyTitle className="text-2xl font-semibold sm:text-3xl">
            No sailor found
          </EmptyTitle>
          <EmptyDescription className="text-base">
            Invite a friend to join your crew and set sail together.
          </EmptyDescription>
        </div>
      </EmptyHeader>
      <EmptyContent className="mt-2 max-w-xs gap-3">
        <Button className="h-11 w-full rounded-xl">
          Invite Code
          <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </Button>
        <Button variant="outline" className="h-11 w-full rounded-xl">
          <UsersRound data-icon="inline-start" aria-hidden="true" />
          Someone sent me the code
        </Button>
      </EmptyContent>
    </Empty>
  )
}
